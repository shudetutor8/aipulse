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
// Optional: GROQ_MODEL, ANTHROPIC_MODEL, AUTO_PUBLISH_POLLS ("false" to review polls and predictions before they go live), SITE_URL

import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import Parser from "rss-parser";
import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";

const env = (k, fallback = "") => (process.env[k] ?? fallback).trim();
const SUPABASE_URL = env("SUPABASE_URL");
const SUPABASE_SECRET_KEY = env("SUPABASE_SECRET_KEY");
const ANTHROPIC_API_KEY = env("ANTHROPIC_API_KEY");
const MODEL = env("ANTHROPIC_MODEL", "claude-haiku-5-5") || "claude-haiku-5-5";
const GROQ_API_KEY = env("GROQ_API_KEY");
const GROQ_MODEL = env("GROQ_MODEL", "openai/gpt-oss-120b") || "openai/gpt-oss-120b";
const AUTO_PUBLISH = env("AUTO_PUBLISH_POLLS") !== "false"; // fully automatic unless set to "false"
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
        const snippet = /news\.google\.com/.test(s.feed_url) ? "" : clean(it.contentSnippet, 900);
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
    const listing = chunk.map(([i, g]) => `[${i}]\n` + g.items.slice(0, 6).map((it) => `- ${it.source}: ${it.title}${it.snippet ? " — " + it.snippet : ""}`).join("\n")).join("\n\n");
    try {
      const res = await askJson(
        "You are the news editor of an AI news site. For each numbered story decide whether it is mainly about artificial intelligence " +
        "(AI models, AI companies, AI chips and datacenters, AI policy, AI research, AI products, AI's effect on jobs or markets). " +
        "Write, in your own words, a neutral factual headline; a summary of what happened (2-4 sentences, max 90 words); 2-4 short key points; " +
        "and one or two sentences on why it matters for AI, people or businesses. Use every source given for that story so the reader doesn't need to leave our site, " +
        "but never copy sentences from the sources and never add facts, numbers or quotes that are not in them. If the sources say little, write less. " +
        `Pick a topic from: ${TOPICS.join(", ")}.`,
        `Stories:\n\n${listing}\n\nReturn {"stories":[{"i":0,"about_ai":true,"topic":"models","headline":"...","summary":"...","key_points":["..."],"why_it_matters":"..."}]} with one entry per story.`,
      );
      for (const s of res.stories || []) {
        if (typeof s.i === "number" && str(s.headline, 160).length >= 5) {
          const points = (Array.isArray(s.key_points) ? s.key_points : []).map((x) => str(x, 200)).filter((x) => x.length > 3).slice(0, 4);
          const why = str(s.why_it_matters, 400);
          out.set(s.i, { aboutAi: s.about_ai !== false, topic: topicOr(s.topic), headline: str(s.headline, 160), summary: str(s.summary, 900) || null,
            details: points.length || why ? { key_points: points, why_it_matters: why || null } : null });
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
      title: s?.headline || lead.title, summary: s?.summary || null, details: s?.details || null, topic: s?.topic || guessTopic(lead.title + " " + lead.snippet),
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
  if (AUTO_PUBLISH) {
    const now = new Date();
    const { data: waiting } = await db.from("polls").update({ status: "live", published_at: now.toISOString(), closes_at: new Date(now.getTime() + 48 * H).toISOString() })
      .eq("status", "pending").eq("origin", "auto").select("id");
    if (waiting?.length) log(`Polls: published ${waiting.length} that were waiting for review`);
  }
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
  await reviewHeld();
  await reviewReports();
}

const RULES = "You are the content moderator of an AI discussion community. Disagreement, criticism, strong opinions and negative views about AI or companies are allowed. " +
  "Remove only: spam or advertising, scams, harassment or personal attacks, hate speech, sexual content, threats or incitement to violence, " +
  "someone's private personal information, or instructions for serious harm.";
async function judge(items) {
  const res = await askJson(RULES,
    `Items:\n${items.map((r, i) => `[${i}] ${r.text}`.slice(0, 1500)).join("\n\n")}\n\n` +
    'Return {"remove":[0]} listing only the items that clearly break the rules (an empty list if none).', 800);
  return new Set((res.remove || []).filter((i) => Number.isInteger(i) && items[i]));
}
// Posts held by the built-in spam check get a second, smarter look so nothing waits for a human.
async function reviewHeld() {
  for (const table of ["posts", "comments"]) {
    const cols = table === "posts" ? "id, title, body" : "id, body";
    const { data } = await db.from(table).select(cols).eq("status", "flagged").eq("ai_checked", false).order("created_at").limit(20);
    const rows = data || [];
    if (!rows.length) continue;
    let remove;
    try { remove = await judge(rows.map((r) => ({ text: (r.title ? r.title + "\n" : "") + r.body }))); } catch (e) { log(`Moderation: second look failed (${e.message})`); continue; }
    const ok = rows.filter((_, i) => !remove.has(i)).map((r) => r.id), bad = rows.filter((_, i) => remove.has(i)).map((r) => r.id);
    if (ok.length) await db.from(table).update({ status: "visible", ai_checked: true }).in("id", ok);
    if (bad.length) await db.from(table).update({ status: "hidden", ai_checked: true }).in("id", bad);
    log(`Moderation: second look at ${rows.length} held ${table}: ${ok.length} approved, ${bad.length} hidden`);
  }
}
// Member reports are decided automatically: hidden if they break the rules, otherwise dismissed.
async function reviewReports() {
  const { data: reports } = await db.from("reports").select("id, target_type, target_id").eq("status", "open").order("created_at").limit(40);
  if (!reports || !reports.length) return;
  const targets = [...new Map(reports.map((r) => [r.target_type + r.target_id, r])).values()].slice(0, 15);
  const [posts, comments] = await Promise.all([
    db.from("posts").select("id, title, body").in("id", targets.filter((t) => t.target_type === "post").map((t) => t.target_id)),
    db.from("comments").select("id, body").in("id", targets.filter((t) => t.target_type === "comment").map((t) => t.target_id)),
  ]);
  const text = new Map([...(posts.data || []).map((x) => [x.id, x.title + "\n" + x.body]), ...(comments.data || []).map((x) => [x.id, x.body])]);
  const live = targets.filter((t) => text.has(t.target_id));
  let remove = new Set();
  if (live.length) {
    try { remove = await judge(live.map((t) => ({ text: text.get(t.target_id) }))); } catch (e) { return log(`Moderation: report review failed (${e.message})`); }
  }
  let hidden = 0, dismissed = 0;
  for (const t of targets) {
    const i = live.indexOf(t), isBad = i >= 0 && remove.has(i);
    if (isBad) { await db.from(t.target_type === "post" ? "posts" : "comments").update({ status: "hidden" }).eq("id", t.target_id); hidden++; } else dismissed++;
    await db.from("reports").update({ status: isBad || i < 0 ? "resolved" : "dismissed" }).eq("target_type", t.target_type).eq("target_id", t.target_id).eq("status", "open");
  }
  log(`Moderation: reviewed ${targets.length} reported items: ${hidden} hidden, ${dismissed} kept`);
}

// ----------------------------------------------------------------------------- predictions
async function jobPredictions() {
  // Daily snapshot of every live crowd forecast, used for the "up/down this week" trend.
  const day = new Date().toISOString().slice(0, 10);
  const { data: live } = await db.from("predictions").select("id, crowd_prob").eq("status", "live");
  const snaps = (live || []).filter((p) => p.crowd_prob != null).map((p) => ({ prediction_id: p.id, day, crowd_prob: p.crowd_prob }));
  if (snaps.length) await db.from("prediction_history").upsert(snaps, { onConflict: "prediction_id,day" });
  const weekAgo = new Date(Date.now() - 7 * 24 * H).toISOString().slice(0, 10);
  for (const p of live || []) {
    const { data: old } = await db.from("prediction_history").select("crowd_prob").eq("prediction_id", p.id).gte("day", weekAgo).order("day").limit(1).maybeSingle();
    if (old && old.crowd_prob != null) await db.from("predictions").update({ prob_week_ago: old.crowd_prob }).eq("id", p.id);
  }
  if (AUTO_PUBLISH) {
    const { data: waiting } = await db.from("predictions").update({ status: "live", published_at: new Date().toISOString() })
      .eq("status", "pending").gt("closes_at", new Date().toISOString()).select("id");
    if (waiting?.length) log(`Predictions: published ${waiting.length} that were waiting for review`);
  }
  if (!claude) return log("Predictions: no AI available, skipping");
  await settlePredictions(day);
  const { count: pending } = await db.from("predictions").select("id", { count: "exact", head: true }).eq("status", "pending");
  if ((pending || 0) >= 6) return log("Predictions: review queue already has 6; approve or reject them in Admin first");
  if ((live || []).length >= 20) return log("Predictions: 20 already open; not adding more");
  const stories = await topStories(48, 15);
  if (stories.length < 3) return log("Predictions: not enough recent stories yet");
  const { data: recent } = await db.from("predictions").select("question").gte("created_at", new Date(Date.now() - 60 * 24 * H).toISOString()).limit(60);
  const res = await askJson(
    "You write questions for a free AI forecasting game (no money involved). Each question is a yes/no question about a future AI event that " +
    "anyone can check later from public news or official announcements, with a clear deadline. Good: product launches, laws passed, benchmark records, " +
    "company announcements, adoption milestones. Never ask about stock prices or investments, deaths, health of specific people, crimes, violence, " +
    "elections or candidates, or private individuals. Avoid questions whose answer is already known. Be neutral and precise.",
    `Today is ${day}. Top AI stories:\n${stories.map((s, i) => `[${i}] ${s.title}${s.summary ? " — " + s.summary : ""}`).join("\n")}\n\n` +
    `Questions already asked (do not repeat):\n${(recent || []).map((p) => "- " + p.question).join("\n") || "- none"}\n\n` +
    `Write up to 2 questions. resolves_by must be between 21 and 365 days from today (YYYY-MM-DD). criteria says exactly what counts as YES, in 1-2 sentences. Topics: ${TOPICS.join(", ")}.\n` +
    'Return {"predictions":[{"question":"Will ... by <date>?","criteria":"...","resolves_by":"YYYY-MM-DD","search":"3-6 word news search that would find the answer","topic":"...","story_indexes":[0]}]}',
  );
  let made = 0;
  for (const p of (res.predictions || []).slice(0, 2)) {
    const question = str(p.question, 200);
    const by = /^\d{4}-\d{2}-\d{2}$/.test(p.resolves_by || "") ? new Date(p.resolves_by + "T00:00:00Z") : null;
    const days = by ? (by.getTime() - Date.now()) / (24 * H) : 0;
    if (question.length < 10 || !by || days < 14 || days > 400) continue;
    const { error } = await db.from("predictions").insert({
      question, criteria: str(p.criteria, 800) || null, topic: topicOr(p.topic), origin: "auto",
      status: AUTO_PUBLISH ? "live" : "pending", published_at: AUTO_PUBLISH ? new Date().toISOString() : null,
      story_ids: (Array.isArray(p.story_indexes) ? p.story_indexes : []).map((i) => stories[i]?.id).filter(Boolean),
      closes_at: by.toISOString(), resolves_by: p.resolves_by, search_query: str(p.search, 120) || null,
    });
    if (error) log("  could not save prediction:", error.message); else made++;
  }
  log(`Predictions: wrote ${made} (${AUTO_PUBLISH ? "published" : "waiting for your review in Admin"})`);
}

// Checks the news to settle predictions automatically.
// YES as soon as reliable reports confirm it; NO only 2+ days after the deadline; cancelled if still unclear 3 weeks after.
const DAY = 24 * H;
export const hooks = { newsSearch: (q) => newsSearch(q) }; // replaceable in tests
async function newsSearch(q) {
  const parser = new Parser({ timeout: 15000, headers: { "User-Agent": "AIPulseBot/1.0 (+news reader)" } });
  const feed = await parser.parseURL(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`);
  return (feed.items || []).map((it) => ({ title: clean(it.title, 220), date: it.isoDate || it.pubDate || "", link: it.link || "" }))
    .sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 15);
}
async function settlePredictions(day) {
  if (usingLocalOnly() || (claude && claude.groqDown)) return log("Predictions: auto-settling waits for the main AI (Groq); the small backup model isn't trusted to settle");
  const { data: rows } = await db.from("predictions").select("id, question, criteria, resolves_by, published_at, search_query, last_checked_at")
    .eq("status", "live").order("last_checked_at", { ascending: true, nullsFirst: true }).limit(40);
  const now = Date.now();
  // Due ones first, then the rest (a YES can come early). At most 6 checks per run.
  const list = (rows || []).filter((p) => !p.last_checked_at || now - new Date(p.last_checked_at).getTime() > 20 * H)
    .sort((a, b) => (a.resolves_by <= day ? 0 : 1) - (b.resolves_by <= day ? 0 : 1)).slice(0, 6);
  let settled = 0;
  for (const p of list) {
    const deadline = new Date(p.resolves_by + "T23:59:59Z").getTime();
    const daysPast = (now - deadline) / DAY;
    const q = p.search_query || [...tokens(p.question)].slice(0, 6).join(" ");
    let news = [];
    try { news = await hooks.newsSearch(q); } catch (e) { log(`  news search failed for "${p.question}": ${e.message}`); }
    await db.from("predictions").update({ last_checked_at: new Date().toISOString() }).eq("id", p.id);
    if (!news.length && daysPast < 21) continue;
    let res;
    try {
      res = await askJson(
        "You settle questions in a free forecasting game using news headlines. Be strict and factual. Answer YES only if the headlines clearly report " +
        "that the event in the criteria has already happened (announcements of plans, rumors or opinions do not count). Answer NO if the deadline has passed " +
        "and the headlines give no sign it happened, or they clearly report it did not or cannot happen in time. Otherwise answer unclear.",
        `Today: ${day}\nQuestion: ${p.question}\nCounts as YES if: ${p.criteria || "the event in the question happens by the deadline"}\nDeadline: ${p.resolves_by} (${daysPast > 0 ? "passed" : "not yet passed"})\n` +
        `Question published: ${(p.published_at || "").slice(0, 10)}\n\nRecent headlines:\n${news.map((n, i) => `[${i}] ${n.date.slice(0, 16)} ${n.title}`).join("\n") || "(none found)"}\n\n` +
        'Return {"outcome":"yes|no|unclear","confidence":0.0,"evidence":"one short sentence","source_index":0}',
        800,
      );
    } catch (e) { log(`  could not check "${p.question}": ${e.message}`); continue; }
    const outcome = String(res.outcome || "").toLowerCase(), conf = Number(res.confidence) || 0;
    const src = news[res.source_index];
    const note = (str(res.evidence, 300) + (src ? ` Source: ${src.title} ${src.link}` : "")).slice(0, 560) + " (Settled automatically from news reports.)";
    let result;
    if (outcome === "yes" && conf >= 0.85) result = true;
    else if (outcome === "no" && conf >= 0.8 && daysPast >= 2) result = false;
    else if (daysPast >= 21) result = null;
    else continue;
    const { error } = await db.rpc("settle_prediction", { p_id: p.id, p_outcome: result,
      p_note: result === null ? "Cancelled: the news didn't make the answer clear enough to score fairly. No points either way." : note });
    if (error) log(`  could not settle "${p.question}": ${error.message}`);
    else { settled++; log(`  settled ${result === null ? "CANCELLED" : result ? "YES" : "NO"}: ${p.question}`); }
  }
  log(`Predictions: checked ${list.length} against the news, settled ${settled}`);
}

// ----------------------------------------------------------------------------- model index
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function countMentions(models, stories, since) {
  const out = Object.fromEntries(models.map((m) => [m.id, { week: 0, prev: 0 }]));
  const res = models.map((m) => [m.id, new RegExp(`\\b(${[m.name.split(" / ")[0], ...(m.aliases || [])].map(escRe).join("|")})\\b`, "i")]);
  for (const s of stories) {
    const text = `${s.title} ${s.summary || ""}`;
    const bucket = new Date(s.created_at).getTime() >= since ? "week" : "prev";
    for (const [id, re] of res) if (re.test(text)) out[id][bucket]++;
  }
  return out;
}
async function jobModels() {
  const { data: models } = await db.from("models").select("id, name, aliases").eq("active", true);
  if (!models || !models.length) return log("Models: none in the index");
  const now = Date.now(), from = new Date(now - 14 * 24 * H).toISOString();
  const stories = [];
  for (let page = 0; page < 20; page++) {
    const { data } = await db.from("news_stories").select("title, summary, created_at").eq("is_hidden", false).gte("created_at", from)
      .order("created_at").range(page * 1000, page * 1000 + 999);
    stories.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const counts = countMentions(models, stories, now - 7 * 24 * H);
  for (const m of models) await db.from("models").update({ mentions_week: counts[m.id].week, mentions_prev_week: counts[m.id].prev }).eq("id", m.id);
  log(`Models: counted mentions in ${stories.length} stories for ${models.length} models`);
}

// ----------------------------------------------------------------------------- full articles
// For the top stories, the robot reads the original reports and writes its OWN complete article,
// so readers get the whole story on our site. Facts are reported in new words; nothing is copied.
const ARTICLES_PER_RUN = 3, ARTICLES_PER_DAY = 30;
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const PAYWALLED = /(^|\.)(wsj|bloomberg|ft|nytimes|economist|theinformation|barrons|washingtonpost|thetimes|telegraph|businessinsider|seekingalpha)\.(com|co\.uk)$/i;
async function fetchText(url, init = {}) {
  const r = await fetch(url, { ...init, redirect: "follow", signal: AbortSignal.timeout(15000),
    headers: { "user-agent": BROWSER_UA, "accept-language": "en-US,en;q=0.9", accept: "text/html,application/xhtml+xml,*/*;q=0.8", ...(init.headers || {}) } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return { text: await r.text(), url: r.url || url };
}
// Google News links hide the real article address; this asks Google for it, the same way its own page does.
export async function resolveGoogleNews(url) {
  const m = String(url).match(/news\.google\.com\/(?:rss\/)?articles\/([A-Za-z0-9_-]+)/);
  if (!m) return url;
  const id = m[1];
  const { text: html } = await fetchText(`https://news.google.com/rss/articles/${id}?hl=en-US&gl=US&ceid=US:en`);
  const sg = html.match(/data-n-a-sg="([^"]+)"/)?.[1], ts = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
  if (!sg || !ts) throw new Error("no signature");
  const inner = `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${ts},"${sg}"]`;
  const { text } = await fetchText("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: "f.req=" + encodeURIComponent(JSON.stringify([[["Fbv4je", inner, null, "generic"]]])),
  });
  const real = JSON.parse(JSON.parse(text.split("\n\n")[1])[0][2])[1];
  if (!/^https?:\/\//.test(real || "")) throw new Error("no address");
  return real;
}
// The picture a news page shows when it is shared (og:image), used as our story picture.
export function shareImage(html, pageUrl) {
  const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*>/i);
  const c = m && m[0].match(/content=["']([^"']+)["']/i);
  if (!c) return null;
  try {
    const u = new URL(c[1].replace(/&amp;/g, "&"), pageUrl);
    if (u.protocol !== "https:" || /logo|favicon|placeholder|default[-_]?(image|share)|google\.com\/images|gstatic/i.test(u.href)) return null;
    return u.href.slice(0, 1000);
  } catch (e) { return null; }
}
export function extractArticle(html, url) {
  const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() });
  const art = new Readability(dom.window.document, { charThreshold: 400 }).parse();
  dom.window.close();
  return art ? clean(art.textContent, 20000) : "";
}
const words = (t) => t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
// How many 10-word runs of our article also appear in the sources (0 = fully original wording).
export function copiedRuns(article, sources, n = 10) {
  const seen = new Set();
  for (const s of sources) { const w = words(s); for (let i = 0; i + n <= w.length; i++) seen.add(w.slice(i, i + n).join(" ")); }
  const w = words(article); let hits = 0;
  for (let i = 0; i + n <= w.length; i++) if (seen.has(w.slice(i, i + n).join(" "))) hits++;
  return hits;
}
async function readSources(links) {
  const out = [];
  for (const l of links.slice(0, 6)) {
    if (out.length >= 3) break;
    try {
      const real = await resolveGoogleNews(l.url);
      const host = new URL(real).hostname.replace(/^www\./, "");
      if (PAYWALLED.test(host)) continue;
      const { text: html, url } = await fetchText(real);
      const body = extractArticle(html, url);
      if (body.length >= 700) out.push({ name: l.source_name, url: real, text: body.slice(0, 3500), image: shareImage(html, url) });
    } catch (e) { /* unreadable source (blocked, paywall, timeout): try the next one */ }
  }
  return out;
}
// Can this page be shown inside our site? Publishers say no with X-Frame-Options or a CSP "frame-ancestors" rule.
export function allowsEmbedding(headers) {
  const xfo = (headers.get("x-frame-options") || "").toLowerCase();
  if (xfo.includes("deny") || xfo.includes("sameorigin")) return false;
  const csp = (headers.get("content-security-policy") || "").toLowerCase();
  const fa = csp.split(";").map((x) => x.trim()).find((x) => x.startsWith("frame-ancestors"));
  if (fa && !/\s\*(\s|$)/.test(fa + " ") && !/aiorhype\.com/.test(fa)) return false;
  return true;
}
// For recent sources: find the real article address, whether it can open in our reader window, and a story picture.
async function checkLinks() {
  const { data: stories } = await db.from("news_stories").select("id, image_url").eq("is_hidden", false)
    .gte("created_at", new Date(Date.now() - 48 * H).toISOString()).order("source_count", { ascending: false }).limit(40);
  if (!stories || !stories.length) return;
  const needImg = new Set(stories.filter((x) => !x.image_url).map((x) => x.id));
  const { data: links } = await db.from("news_links").select("id, story_id, url").eq("checked", false).in("story_id", stories.map((x) => x.id)).order("id").limit(40);
  let ok = 0, framed = 0, pics = 0;
  for (const l of links || []) {
    let real = null, frameable = false;
    try {
      real = await resolveGoogleNews(l.url);
      const r = await fetch(real, { redirect: "follow", signal: AbortSignal.timeout(15000), headers: { "user-agent": BROWSER_UA, accept: "text/html,*/*;q=0.8" } });
      real = r.url || real;
      frameable = r.ok && real.startsWith("https://") && allowsEmbedding(r.headers);
      if (r.ok && needImg.has(l.story_id)) {
        const img = shareImage(await r.text(), real);
        if (img) { await db.from("news_stories").update({ image_url: img, image_checked: true }).eq("id", l.story_id); needImg.delete(l.story_id); pics++; }
      } else { try { await r.body?.cancel(); } catch (e) {} }
      ok++; if (frameable) framed++;
    } catch (e) { /* unreachable: keep it as a plain credit */ }
    await db.from("news_links").update({ checked: true, real_url: real && /^https?:\/\//.test(real) ? real.slice(0, 1000) : null, frameable }).eq("id", l.id);
  }
  log(`Sources: checked ${(links || []).length}, ${framed} can open in the reader window, ${pics} pictures found`);
}
async function jobArticles() {
  try { await checkLinks(); } catch (e) { log("Sources: skipped (" + e.message + ")"); }
  if (!claude || usingLocalOnly() || claude.groqDown) return log("Articles: waiting for the main AI (Groq); skipping");
  const dayAgo = new Date(Date.now() - 24 * H).toISOString();
  const { count: today } = await db.from("news_stories").select("id", { count: "exact", head: true }).gte("article_at", dayAgo);
  const room = Math.min(ARTICLES_PER_RUN, ARTICLES_PER_DAY - (today || 0));
  if (room <= 0) return log(`Articles: daily limit of ${ARTICLES_PER_DAY} reached`);
  const { data: cands } = await db.from("news_stories").select("id, title, summary, topic, source_count, article_tries, image_url")
    .is("article", null).eq("is_hidden", false).lt("article_tries", 2).gte("created_at", new Date(Date.now() - 36 * H).toISOString())
    .order("source_count", { ascending: false }).order("created_at", { ascending: false }).limit(12);
  let written = 0;
  for (const st of cands || []) {
    if (written >= room) break;
    const { data: links } = await db.from("news_links").select("source_name, url, title").eq("story_id", st.id).order("published_at", { ascending: false }).limit(8);
    const sources = await readSources(links || []);
    await db.from("news_stories").update({ article_tries: (st.article_tries || 0) + 1 }).eq("id", st.id);
    if (!sources.length) { log(`  no readable source for "${st.title}"`); continue; }
    let res;
    try {
      res = await askJson(
        "You are a staff writer at an AI news site. Write an original, complete news article based ONLY on the source reports provided. " +
        "Rules: write every sentence in your own words (never copy or closely paraphrase sentences; no direct quotes); report only facts stated in the sources and " +
        "attribute claims (\"according to ...\"); be neutral and precise; no speculation, no hype, no advice; explain technical terms simply. " +
        "Length: 350-550 words in 4-7 short paragraphs. If the sources disagree, say so.",
        `Story: ${st.title}\n\n` + sources.map((s, i) => `SOURCE ${i + 1} (${s.name}):\n${s.text}`).join("\n\n") + "\n\n" +
        'Return {"headline":"...","paragraphs":["...","..."],"key_points":["...","...","..."],"background":"1-3 sentences of context","whats_next":"1-2 sentences on what to watch, only if the sources say","why_it_matters":"1-2 sentences"}',
        2500,
      );
    } catch (e) { log(`  could not write "${st.title}": ${e.message}`); continue; }
    const paragraphs = (Array.isArray(res.paragraphs) ? res.paragraphs : []).map((x) => str(x, 1500)).filter((x) => x.length > 40).slice(0, 9);
    const all = [...paragraphs, res.background || "", res.whats_next || "", ...(res.key_points || [])].join(" ");
    const wordCount = words(paragraphs.join(" ")).length;
    if (wordCount < 200) { log(`  article too short for "${st.title}"`); continue; }
    const copied = copiedRuns(all, sources.map((s) => s.text));
    if (copied > 2) { log(`  rejected "${st.title}": too close to a source's wording (${copied} copied runs)`); continue; }
    const points = (Array.isArray(res.key_points) ? res.key_points : []).map((x) => str(x, 220)).filter((x) => x.length > 3).slice(0, 5);
    const { error } = await db.from("news_stories").update({
      title: str(res.headline, 160).length >= 10 ? str(res.headline, 160) : st.title,
      article: { paragraphs, background: str(res.background, 600) || null, whats_next: str(res.whats_next, 500) || null, words: wordCount,
        sources: sources.map((s) => ({ name: s.name, url: s.url })) },
      details: { key_points: points, why_it_matters: str(res.why_it_matters, 400) || null },
      article_at: new Date().toISOString(),
      ...(sources.find((s) => s.image) && !st.image_url ? { image_url: sources.find((s) => s.image).image } : {}),
    }).eq("id", st.id);
    if (error) log("  could not save article:", error.message); else { written++; log(`  wrote full article (${wordCount} words): ${st.title}`); }
  }
  log(`Articles: wrote ${written} full articles (${(today || 0) + written} in the last 24 hours)`);
}

// ----------------------------------------------------------------------------- main
const JOBS = { articles: jobArticles, news: jobNews, moderate: jobModerate, polls: jobPolls, discussion: jobDiscussion, predictions: jobPredictions, models: jobModels };
export async function main() {
  let names = process.argv.slice(2).flatMap((a) => a.split(/[\s,]+/)).filter(Boolean);
  if (!names.length || names.includes("all")) names = ["news", "articles", "moderate", "polls", "predictions", "models", "discussion"];
  const unknown = names.filter((n) => !JOBS[n]);
  if (unknown.length) throw new Error("Unknown job: " + unknown.join(", ") + ". Use news, articles, moderate, polls, predictions, models, discussion or all.");
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
