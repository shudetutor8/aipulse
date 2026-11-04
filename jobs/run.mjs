// AI Pulse automatic jobs. GitHub Actions runs this on a schedule.
//
//   node run.mjs news moderate      collect news, check new posts (every 30 minutes)
//   node run.mjs polls              write hot-topic polls from today's news (every 6 hours)
//   node run.mjs discussion         post the "Discussion of the day" (every morning)
//   node run.mjs all                everything
//
// Needs these environment variables (GitHub → Settings → Secrets and variables → Actions):
//   SUPABASE_URL, SUPABASE_SECRET_KEY
//   and optionally an AI key: GROQ_API_KEY (free, console.groq.com) or ANTHROPIC_API_KEY (paid).
// Without a key, or when Groq is over its limit or down, the jobs use a free open-source
// model (Qwen3-4B) that the workflow downloads and runs on GitHub's own computers (LOCAL_AI_DIR).
// Optional: GROQ_MODEL, ANTHROPIC_MODEL, AUTO_PUBLISH_POLLS ("true" to skip review), SITE_URL

import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import Parser from "rss-parser";

const env = (k, fallback = "") => (process.env[k] ?? fallback).trim();
const SUPABASE_URL = env("SUPABASE_URL");
const SUPABASE_SECRET_KEY = env("SUPABASE_SECRET_KEY");
const ANTHROPIC_API_KEY = env("ANTHROPIC_API_KEY");
const MODEL = env("ANTHROPIC_MODEL", "claude-haiku-5-5") || "claude-haiku-5-5";
const GROQ_API_KEY = env("GROQ_API_KEY");
const GROQ_MODEL = env("GROQ_MODEL", "openai/gpt-oss-120b") || "openai/gpt-oss-120b";
const AUTO_PUBLISH = env("AUTO_PUBLISH_POLLS") === "true";
const SITE_URL = env("SITE_URL", "https://example.com");

export const TOPICS = ["models", "agents", "chips", "policy", "funding", "research", "jobs", "stocks", "building", "general"];
const MAX_AGE_HOURS = 48;
const MAX_NEW_STORIES = 25;
const SIMILARITY = 0.45;
const H = 3_600_000;

let db = null;
// The AI used by the jobs. primary = "groq" | "anthropic" | "local"; local = built-in model available as a fallback.
let claude = null;
const LOCAL_AI_DIR = env("LOCAL_AI_DIR");
function localAiAvailable() {
  return Boolean(LOCAL_AI_DIR) && fs.existsSync(path.join(LOCAL_AI_DIR, "model.gguf")) && fs.existsSync(path.join(LOCAL_AI_DIR, "server-path.txt"));
}
export function connect() {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY secret.");
  db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const local = localAiAvailable();
  if (GROQ_API_KEY) claude = { primary: "groq", local, groqDown: false };
  else if (ANTHROPIC_API_KEY) claude = { primary: "anthropic", client: new Anthropic({ apiKey: ANTHROPIC_API_KEY }), local };
  else if (local) claude = { primary: "local", local };
}
// The built-in model is slow, so it gets smaller batches.
const usingLocalOnly = () => claude && claude.primary === "local";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ----------------------------------------------------------------------------- Claude
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  if (start === -1 || end === -1) throw new Error("Claude's reply had no JSON");
  return JSON.parse(body.slice(start, end + 1));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- built-in model (llama.cpp server on this computer), started only when needed
const LOCAL_PORT = 8089;
let localServer = null;
async function startLocal() {
  if (localServer) return localServer.ready;
  const bin = fs.readFileSync(path.join(LOCAL_AI_DIR, "server-path.txt"), "utf8").trim();
  log("  starting the built-in AI model (first use this run)…");
  const child = spawn(bin, [
    "-m", path.join(LOCAL_AI_DIR, "model.gguf"), "--host", "127.0.0.1", "--port", String(LOCAL_PORT),
    "-c", "8192", "-t", String(Math.max(1, os.cpus().length)), "--no-webui",
  ], { stdio: "ignore", env: { ...process.env, LD_LIBRARY_PATH: [path.dirname(bin), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") } });
  const ready = (async () => {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("built-in AI model failed to start");
      try { if ((await fetch(`http://127.0.0.1:${LOCAL_PORT}/health`)).ok) return; } catch {}
      await sleep(1000);
    }
    throw new Error("built-in AI model took too long to start");
  })();
  localServer = { child, ready };
  try { await ready; log("  built-in AI model ready"); }
  catch (e) { child.kill(); localServer = null; claude.local = false; throw e; }
}
export function stopLocal() { if (localServer) { localServer.child.kill(); localServer = null; } }
async function askLocal(system, prompt, maxTokens) {
  await startLocal();
  const res = await fetch(`http://127.0.0.1:${LOCAL_PORT}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ max_tokens: maxTokens, temperature: 0.3, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!res.ok) throw new Error(`built-in AI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}
async function askGroq(system, prompt, maxTokens) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        max_tokens: maxTokens + (/gpt-oss/.test(GROQ_MODEL) ? 1500 : 0), // room for the model's short thinking step
        temperature: 0.3,
        ...(/gpt-oss/.test(GROQ_MODEL) ? { reasoning_effort: "low" } : {}),
        messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 429 && attempt < 3) { await sleep(20_000 * attempt); continue; } // free-tier rate limit: wait and retry
    if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  }
  throw new Error("Groq rate limit: try again later");
}
export async function askJson(system, prompt, maxTokens = 3000) {
  const fullSystem = system + "\n\nReply with JSON only, no other text.";
  if (claude.primary === "groq" && !claude.groqDown) {
    try {
      return extractJson(await askGroq(fullSystem, prompt, maxTokens));
    } catch (e) {
      if (!claude.local) throw e;
      log(`  Groq unavailable (${String(e.message).slice(0, 120)}); switching to the built-in AI model`);
      claude.groqDown = true;
    }
  }
  if (claude.primary === "local" || claude.groqDown) return extractJson(await askLocal(fullSystem, prompt, maxTokens));
  const msg = await claude.client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system: fullSystem,
    messages: [{ role: "user", content: prompt }],
  });
  return extractJson(msg.content.map((b) => (b.type === "text" ? b.text : "")).join(""));
}
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const topicOr = (t) => (TOPICS.includes(t) ? t : "general");

// ----------------------------------------------------------------------------- news
const STOPWORDS = new Set("the a an and or but for with from into onto over under about after before to of in on at by as is are was were be been it its this that these those how why what who new says say said will can could may might than more most just now".split(" "));
export function tokens(title) {
  return new Set(title.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w)));
}
export function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}
const clean = (s, max) => (s || "").replace(/\s+/g, " ").trim().slice(0, max);
function pickImage(item) {
  const c = [item.enclosure?.url, item.media?.$?.url, item.thumb?.$?.url].find((u) => typeof u === "string" && /^https:\/\//.test(u));
  return c && !/\.(mp3|mp4|m4a)(\?|$)/i.test(c) ? c : null;
}
const KEYWORDS = [
  ["chips", /\b(chip|gpu|semiconductor|datacenter|data center|compute)\b/i],
  ["policy", /\b(law|regulat|senate|congress|lawsuit|court|policy|safety)\b/i],
  ["funding", /\b(raises|funding|series [a-e]|valuation|acqui|ipo)\b/i],
  ["agents", /\bagent/i],
  ["jobs", /\b(jobs|layoff|workers|hiring|employment)\b/i],
  ["research", /\b(paper|research|study|benchmark)\b/i],
  ["stocks", /\b(stock|shares|earnings|investors)\b/i],
  ["models", /\b(model|llm|release)\b/i],
];
const guessTopic = (t) => KEYWORDS.find(([, re]) => re.test(t))?.[0] ?? "general";

// Web-wide AI news: Google News searches that cover thousands of outlets.
// They are added to News sources automatically, so you can pause any of them in Admin.
const gnews = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:1d")}&hl=en-US&gl=US&ceid=US:en`;
export const WEB_SEARCHES = [
  ["Web: artificial intelligence", gnews('"artificial intelligence" OR "generative AI"')],
  ["Web: AI companies", gnews("OpenAI OR Anthropic OR \"Google DeepMind\" OR \"Meta AI\" OR xAI OR Mistral")],
  ["Web: AI models & chatbots", gnews("ChatGPT OR Claude OR Gemini OR Llama OR Copilot OR \"AI model\"")],
  ["Web: AI agents", gnews('"AI agent" OR "AI agents" OR "agentic AI"')],
  ["Web: AI chips & datacenters", gnews('Nvidia AI OR "AI chips" OR "AI data center"')],
  ["Web: AI policy", gnews('"AI regulation" OR "AI safety" OR "AI law" OR "AI act"')],
  ["Web: AI business & stocks", gnews('"AI stocks" OR "AI startup" OR "AI funding" OR "AI spending"')],
  ["Web: AI & jobs", gnews('"AI jobs" OR "AI layoffs" OR "AI workers" OR "AI automation"')],
];
async function ensureWebSearches() {
  const { error } = await db.from("news_sources")
    .upsert(WEB_SEARCHES.map(([name, feed_url]) => ({ name, feed_url })), { onConflict: "feed_url", ignoreDuplicates: true });
  if (error) log("  could not add web searches:", error.message);
}

// Used when no AI key is set: keep only articles that are clearly about AI.
const AI_WORDS = /\b(AI|A\.I\.|AGI|LLMs?|GPTs?|ChatGPT|OpenAI|Anthropic|Claude|Gemini|DeepMind|Copilot|Llama|Mistral|Grok|xAI|chatbots?|machine learning|deep learning|neural network|generative|artificial intelligence|AI agents?|agentic|foundation models?|large language models?)\b/;
export const looksLikeAiNews = (text) => AI_WORDS.test(text || "");

// Google News titles end with " - Publisher"; use the real publisher as the source name.
export function publisherOf(item, feedName, feedUrl) {
  if (!/news\.google\.com/.test(feedUrl)) return { source: feedName, title: item.title };
  const pub = (typeof item.gsource === "string" ? item.gsource : item.gsource?._) || "";
  let title = item.title || "";
  const suffix = pub ? " - " + pub : title.match(/ - [^-]{2,60}$/)?.[0] || "";
  if (suffix && title.endsWith(suffix)) title = title.slice(0, -suffix.length);
  return { source: (pub || suffix.slice(3) || "Google News").trim(), title: title.trim() };
}

async function fetchFeeds() {
  await ensureWebSearches();
  const { data: sources, error } = await db.from("news_sources").select("id, name, feed_url").eq("active", true);
  if (error) throw error;
  const parser = new Parser({
    timeout: 15_000,
    headers: { "User-Agent": `AI Pulse news reader (+${SITE_URL})` },
    customFields: { item: [["media:content", "media"], ["media:thumbnail", "thumb"], ["source", "gsource"]] },
  });
  const cutoff = Date.now() - MAX_AGE_HOURS * H;
  const items = [];
  await Promise.all((sources || []).map(async (s) => {
    try {
      const feed = await parser.parseURL(s.feed_url);
      let n = 0;
      for (const it of feed.items || []) {
        if (!it.link || !it.title || !/^https?:\/\//.test(it.link)) continue;
        const date = it.isoDate ? new Date(it.isoDate) : null;
        if (date && date.getTime() < cutoff) continue;
        const named = publisherOf(it, s.name, s.feed_url);
        const snippet = /news\.google\.com/.test(s.feed_url) ? "" : clean(it.contentSnippet, 400);
        if (!claude && !looksLikeAiNews(named.title + " " + snippet)) continue;
        items.push({ source: named.source, url: it.link.trim(), title: clean(named.title, 300), snippet,
          publishedAt: date && !isNaN(date) ? date.toISOString() : null, image: pickImage(it) });
        n++;
      }
      log(`  ${s.name}: ${n} recent items`);
      await db.from("news_sources").update({ last_fetched_at: new Date().toISOString(), last_error: null }).eq("id", s.id);
    } catch (e) {
      log(`  ${s.name}: FAILED ${e.message}`);
      await db.from("news_sources").update({ last_fetched_at: new Date().toISOString(), last_error: String(e.message).slice(0, 300) }).eq("id", s.id);
    }
  }));
  return items;
}

async function unseen(items) {
  const unique = [...new Map(items.map((i) => [i.url, i])).values()];
  const seen = new Set();
  for (let i = 0; i < unique.length; i += 100) {
    const urls = unique.slice(i, i + 100).map((x) => x.url);
    const [a, b] = await Promise.all([
      db.from("news_links").select("url").in("url", urls),
      db.from("news_skipped").select("url").in("url", urls),
    ]);
    for (const r of [...(a.data || []), ...(b.data || [])]) seen.add(r.url);
  }
  return unique.filter((i) => !seen.has(i.url));
}

export function groupItems(fresh, recentStories) {
  const groups = recentStories.map((s) => ({ storyId: s.id, items: [], tokens: tokens(s.title) }));
  for (const item of fresh) {
    const t = tokens(item.title);
    let best = null, bestScore = 0;
    for (const g of groups) {
      const score = similarity(t, g.tokens);
      if (score > bestScore) { best = g; bestScore = score; }
    }
    if (best && bestScore >= SIMILARITY) best.items.push(item);
    else groups.push({ items: [item], tokens: t });
  }
  return groups;
}

async function summarize(groups) {
  const out = new Map();
  if (!claude) return out;
  const chunks = [];
  const size = usingLocalOnly() ? 5 : 10;
  groups.forEach((g, i) => { if (i % size === 0) chunks.push([]); chunks.at(-1).push([i, g]); });
  for (const chunk of chunks) {
    const listing = chunk.map(([i, g]) => `[${i}]\n` + g.items.slice(0, 3).map((it) => `- ${it.source}: ${it.title}${it.snippet ? " — " + it.snippet : ""}`).join("\n")).join("\n\n");
    try {
      const res = await askJson(
        "You are the news editor of an AI news site. For each numbered story decide whether it is mainly about artificial intelligence " +
        "(AI models, AI companies, AI chips and datacenters, AI policy, AI research, AI products, AI's effect on jobs or markets). " +
        "Write a neutral, factual headline and a 2-3 sentence summary in your own words (max 60 words). Never copy sentences from the source and never add facts that are not in it. " +
        `Pick a topic from: ${TOPICS.join(", ")}.`,
        `Stories:\n\n${listing}\n\nReturn {"stories":[{"i":0,"about_ai":true,"topic":"models","headline":"...","summary":"..."}]} with one entry per story.`,
      );
      for (const s of res.stories || []) {
        if (typeof s.i === "number" && str(s.headline, 160).length >= 5) {
          out.set(s.i, { aboutAi: s.about_ai !== false, topic: topicOr(s.topic), headline: str(s.headline, 160), summary: str(s.summary, 700) || null });
        }
      }
    } catch (e) {
      log("  summary batch failed:", e.message);
    }
  }
  return out;
}

async function jobNews() {
  log("News: reading feeds");
  const items = await fetchFeeds();
  const fresh = (await unseen(items)).sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  const since = new Date(Date.now() - MAX_AGE_HOURS * H).toISOString();
  const { data: recent } = await db.from("news_stories").select("id, title").gte("created_at", since).limit(1000);
  const groups = groupItems(fresh, recent || []);

  let linksAdded = 0;
  for (const g of groups.filter((g) => g.storyId && g.items.length)) {
    const { error } = await db.from("news_links").insert(g.items.map((it) => ({ story_id: g.storyId, source_name: it.source, url: it.url, title: it.title, published_at: it.publishedAt })));
    if (error) continue;
    linksAdded += g.items.length;
    const { count } = await db.from("news_links").select("id", { count: "exact", head: true }).eq("story_id", g.storyId);
    await db.from("news_stories").update({ source_count: count || 1 }).eq("id", g.storyId);
  }

  const newGroups = groups.filter((g) => !g.storyId && g.items.length).sort((a, b) => b.items.length - a.items.length).slice(0, usingLocalOnly() ? 12 : MAX_NEW_STORIES);
  const ai = await summarize(newGroups);
  let created = 0, skipped = 0;
  for (const [i, g] of newGroups.entries()) {
    const s = ai.get(i);
    if (claude && !s) continue; // summary failed; try again next run
    if (s && !s.aboutAi) {
      await db.from("news_skipped").upsert(g.items.map((it) => ({ url: it.url })));
      skipped++;
      continue;
    }
    const lead = g.items[0];
    const published = g.items.map((it) => it.publishedAt).filter(Boolean).sort()[0] || new Date().toISOString();
    const { data: story, error } = await db.from("news_stories").insert({
      title: s?.headline || lead.title, summary: s?.summary || null, topic: s?.topic || guessTopic(lead.title + " " + lead.snippet),
      image_url: g.items.find((it) => it.image)?.image || null, published_at: published, source_count: g.items.length,
    }).select("id").single();
    if (error) { log("  could not save story:", error.message); continue; }
    await db.from("news_links").insert(g.items.map((it) => ({ story_id: story.id, source_name: it.source, url: it.url, title: it.title, published_at: it.publishedAt })));
    created++;
  }
  log(`News: ${items.length} items read, ${fresh.length} new, ${created} stories created, ${linksAdded} sources added to existing stories, ${skipped} not about AI`);
}

// ----------------------------------------------------------------------------- polls
async function topStories(hours, limit) {
  const { data } = await db.from("news_stories").select("id, title, summary, topic, source_count, comment_count")
    .eq("is_hidden", false).gte("created_at", new Date(Date.now() - hours * H).toISOString())
    .order("source_count", { ascending: false }).order("comment_count", { ascending: false }).limit(limit);
  return data || [];
}

async function jobPolls() {
  const { data: closed } = await db.from("polls").update({ status: "closed" }).eq("status", "live").lt("closes_at", new Date().toISOString()).select("id");
  log(`Polls: closed ${closed?.length || 0} finished polls`);
  if (!claude) return log("Polls: no AI key set (GROQ_API_KEY) and no built-in model, skipping");
  const { count: pending } = await db.from("polls").select("id", { count: "exact", head: true }).eq("status", "pending");
  if ((pending || 0) >= 6) return log("Polls: review queue already has 6 polls; approve or reject them first");
  const stories = await topStories(36, 15);
  if (stories.length < 3) return log("Polls: not enough recent stories yet");
  const { data: recentPolls } = await db.from("polls").select("question").gte("created_at", new Date(Date.now() - 14 * 24 * H).toISOString()).limit(40);
  const res = await askJson(
    "You write daily community polls for an AI news and discussion site. Polls must be about debatable questions raised by the news: predictions, opinions, trade-offs. " +
    "Be neutral and balanced; options must be mutually exclusive and cover the main views. Never write polls about deaths, crimes, accidents, violence, " +
    "the health of specific people, private individuals, or elections and candidates. Never present speculation as fact. Keep questions short and plain.",
    `Today's top AI stories:\n${stories.map((s, i) => `[${i}] ${s.title}${s.summary ? " — " + s.summary : ""} (${s.source_count} sources)`).join("\n")}\n\n` +
    `Polls asked recently (do not repeat):\n${(recentPolls || []).map((p) => "- " + p.question).join("\n") || "- none"}\n\n` +
    `Write up to 3 polls, each with a 1-2 sentence description giving context for people who missed the news. Topics: ${TOPICS.join(", ")}.\n` +
    'Return {"polls":[{"question":"...","description":"...","topic":"...","options":["...","..."],"story_indexes":[0]}]}',
  );
  const now = new Date();
  let made = 0;
  for (const p of (res.polls || []).slice(0, 3)) {
    const question = str(p.question, 200);
    const options = (Array.isArray(p.options) ? p.options : []).map((o) => str(o, 80)).filter(Boolean).slice(0, 4);
    if (question.length < 10 || options.length < 2) continue;
    const { data: poll, error } = await db.from("polls").insert({
      question, description: str(p.description, 600) || null, topic: topicOr(p.topic), origin: "auto",
      status: AUTO_PUBLISH ? "live" : "pending",
      story_ids: (Array.isArray(p.story_indexes) ? p.story_indexes : []).map((i) => stories[i]?.id).filter(Boolean),
      published_at: AUTO_PUBLISH ? now.toISOString() : null,
      closes_at: AUTO_PUBLISH ? new Date(now.getTime() + 48 * H).toISOString() : null,
    }).select("id").single();
    if (error) { log("  could not save poll:", error.message); continue; }
    await db.from("poll_options").insert(options.map((label, position) => ({ poll_id: poll.id, label, position })));
    made++;
  }
  log(`Polls: wrote ${made} polls (${AUTO_PUBLISH ? "published" : "waiting for your review in Admin"})`);
}

// ----------------------------------------------------------------------------- discussion of the day
async function jobDiscussion() {
  if (!claude) return log("Discussion: no AI key set (GROQ_API_KEY) and no built-in model, skipping");
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const { count } = await db.from("posts").select("id", { count: "exact", head: true }).eq("is_editorial", true).gte("created_at", today.toISOString());
  if (count) return log("Discussion: today's discussion already posted");
  const stories = await topStories(30, 8);
  if (!stories.length) return log("Discussion: no recent stories yet");
  const res = await askJson(
    "You are the editor of an AI community site. Pick the story most likely to spark a thoughtful, civil debate and write a discussion starter. " +
    "Be neutral: summarize the news in your own words, then ask one open question and give two or three angles people might take, without picking a side. " +
    "Avoid stories about deaths, crimes, violence, private individuals, or elections. Keep it under 120 words. Don't pretend to be a person.",
    `Today's top AI stories:\n${stories.map((s, i) => `[${i}] ${s.title}${s.summary ? " — " + s.summary : ""}`).join("\n")}\n\n` +
    'Return {"story_index":0,"title":"An open question, 8-120 characters","body":"Short summary, then the question and angles. Use line breaks between parts.","topic":"..."}',
    1200,
  );
  const story = stories[res.story_index] || stories[0];
  const title = str(res.title, 200);
  const body = str(res.body, 2000);
  if (title.length < 8 || body.length < 20) return log("Discussion: Claude's reply wasn't usable; will try next run");
  const { error } = await db.from("posts").insert({
    author_id: null, is_editorial: true, story_id: story.id, kind: "discussion", title, body,
    topic: topicOr(res.topic || story.topic), ai_checked: true,
  });
  log(error ? "Discussion: could not save: " + error.message : `Discussion: posted "${title}"`);
}

// ----------------------------------------------------------------------------- moderation
async function jobModerate() {
  if (!claude) return log("Moderation: no AI key set (GROQ_API_KEY) and no built-in model, skipping (the built-in spam check still runs)");
  for (const table of ["posts", "comments"]) {
    const cols = table === "posts" ? "id, title, body" : "id, body";
    const { data } = await db.from(table).select(cols).eq("ai_checked", false).eq("status", "visible").order("created_at").limit(usingLocalOnly() ? 15 : 40);
    const rows = data || [];
    if (!rows.length) { log(`Moderation: no new ${table}`); continue; }
    let flagged = [];
    try {
      const res = await askJson(
        "You are the content moderator of an AI discussion community. Disagreement, criticism, strong opinions and negative views about AI or companies are allowed. " +
        "Flag only: spam or advertising, scams, harassment or personal attacks, hate speech, sexual content, threats or incitement to violence, " +
        "someone's private personal information, or instructions for serious harm.",
        `Submissions:\n${rows.map((r, i) => `[${i}] ${(r.title ? r.title + "\n" : "") + r.body}`.slice(0, 1500)).join("\n\n")}\n\n` +
        'Return {"flagged":[{"i":0,"reason":"short reason"}]} listing only the submissions that break the rules (an empty list if none).',
        800,
      );
      flagged = (res.flagged || []).filter((f) => Number.isInteger(f.i) && rows[f.i]).map((f) => rows[f.i].id);
    } catch (e) {
      log(`Moderation: check failed for ${table} (${e.message}); will retry next run`);
      continue;
    }
    const ids = rows.map((r) => r.id);
    await db.from(table).update({ ai_checked: true }).in("id", ids);
    if (flagged.length) await db.from(table).update({ status: "flagged" }).in("id", flagged);
    log(`Moderation: checked ${rows.length} ${table}, held ${flagged.length} for review`);
  }
}

// ----------------------------------------------------------------------------- main
const JOBS = { news: jobNews, moderate: jobModerate, polls: jobPolls, discussion: jobDiscussion };
async function main() {
  let names = process.argv.slice(2).flatMap((a) => a.split(/[\s,]+/)).filter(Boolean);
  if (!names.length || names.includes("all")) names = ["news", "moderate", "polls", "discussion"];
  const unknown = names.filter((n) => !JOBS[n]);
  if (unknown.length) throw new Error("Unknown job: " + unknown.join(", ") + ". Use news, moderate, polls, discussion or all.");
  connect();
  if (!claude) log("Note: no AI available (no GROQ_API_KEY and no built-in model). News is saved without AI summaries; polls and discussions are skipped.");
  else log("AI: " + (claude.primary === "groq" ? "Groq (" + GROQ_MODEL + ")" : claude.primary === "anthropic" ? "Claude (" + MODEL + ")" : "built-in model on GitHub (free)")
    + (claude.primary !== "local" && claude.local ? ", with the built-in model as backup" : ""));
  let failed = false;
  for (const n of names) {
    try { await JOBS[n](); } catch (e) { failed = true; log(`${n} FAILED:`, e.message); }
  }
  stopLocal();
  if (failed) process.exitCode = 1;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("Stopped: " + e.message); process.exitCode = 1; });
}
