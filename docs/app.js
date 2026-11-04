/* AI Pulse — website (runs entirely in the browser, talks to Supabase).
   Pages are addressed with links like  #/news/<id>  so the site works on GitHub Pages. */
(() => {
"use strict";

const CONFIG = window.AIPULSE_CONFIG || {};
const SITE = CONFIG.siteName || "AI Pulse";
const PAGE = 20;
const H = 3600e3;

const TOPICS = [
  ["agents", "AI Agents", "Agents, automation and tools that act on their own"],
  ["models", "Models", "New models, benchmarks and releases"],
  ["jobs", "AI & Jobs", "Work, careers and how AI changes them"],
  ["chips", "Chips & Datacenters", "GPUs, chips, power and compute"],
  ["stocks", "AI Stocks", "Markets, earnings and AI companies"],
  ["policy", "AI Policy", "Laws, regulation and safety"],
  ["funding", "Funding", "Startups, deals and investment"],
  ["research", "Research", "Papers and breakthroughs"],
  ["building", "Building with AI", "Projects, tips and how-tos"],
  ["general", "General", "Everything else about AI"],
];
const NAV_SPACES = ["agents", "jobs", "chips", "policy", "building"];
const topicLabel = (id) => (TOPICS.find((t) => t[0] === id) || TOPICS[9])[1];
const isTopic = (id) => TOPICS.some((t) => t[0] === id);

/* ---------------------------------------------------------------- setup */
const app = document.getElementById("app");
if (!CONFIG.supabaseUrl || !CONFIG.supabaseKey || !window.supabase) {
  app.innerHTML = `<div class="wrap"><div class="card pad stack" style="max-width:640px;margin:64px auto">
    <h1 class="h-page">Almost there</h1>
    <p class="lead">The site is online but isn't connected to its database yet. Open <b>docs/config.js</b> and fill in your Supabase project URL and publishable key, then reload.</p></div></div>`;
  return;
}
const sb = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
  auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true },
});

const S = { userId: null, profile: null, rail: null, railAt: 0 };
const ui = { sort: {}, page: {}, newsTopic: "", reply: null, report: null, confirm: null, err: {}, ok: {}, optCount: 2, busy: false };

/* ---------------------------------------------------------------- helpers */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ago = (iso) => {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return m + "m";
  const h = Math.floor(m / 60); if (h < 24) return h + "h";
  const d = Math.floor(h / 24); if (d < 30) return d + "d";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
const left = (iso) => {
  if (!iso) return null;
  const d = new Date(iso).getTime() - Date.now(); if (d <= 0) return null;
  const h = Math.floor(d / H); if (h >= 24) return Math.floor(h / 24) + "d left";
  return h >= 1 ? h + "h left" : Math.max(1, Math.floor(d / 60000)) + "m left";
};
const fmt = (n) => new Intl.NumberFormat("en-US", { notation: n >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n || 0);
const plural = (n, w, pw) => `${fmt(n)} ${n === 1 ? w : (pw || w + "s")}`;
const pollOpen = (p) => p.status === "live" && (!p.closes_at || new Date(p.closes_at).getTime() > Date.now());
const isUuid = (s) => /^[0-9a-f-]{36}$/i.test(s || "");
const me = () => S.profile;
const errText = (e) => (e && e.message ? e.message.replace(/^.*?:\s(?=[A-Z])/, "") : "Something went wrong. Please try again.");

const PAL = [["#C7D2FE", "#3730A3"], ["#CCFBF1", "#115E59"], ["#FDE68A", "#78350F"], ["#FBCFE8", "#831843"], ["#BBF7D0", "#14532D"], ["#FED7AA", "#7C2D12"]];
function avatar(p, size = 36) {
  if (p && p.editor) return `<span class="avatar" aria-hidden="true" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.34)}px;background:var(--accent);color:#fff">AI</span>`;
  if (p && p.avatar_url) return `<img class="avatar" src="${esc(p.avatar_url)}" alt="" width="${size}" height="${size}" referrerpolicy="no-referrer" style="width:${size}px;height:${size}px">`;
  const name = (p && (p.display_name || p.username)) || "?";
  let h = 0; for (const ch of (p ? p.id : "x")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [bg, fg] = PAL[h % PAL.length];
  return `<span class="avatar" aria-hidden="true" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px;background:${bg};color:${fg}">${esc(name[0].toUpperCase())}</span>`;
}
const EDITOR = { id: "editor", editor: true, display_name: SITE + " Editor", username: null };
const nameOf = (p) => (p ? p.display_name || p.username : "Deleted user");
const isTopForecaster = (p) => p && p.forecasts_scored >= 5 && p.forecasts_right / p.forecasts_scored >= 0.7;
function whoLine(p, sub) {
  const name = p && p.username ? `<a class="who-name" href="#/u/${esc(p.username)}">${esc(nameOf(p))}</a>` : `<span class="who-name">${esc(nameOf(p))}</span>`;
  const badge = isTopForecaster(p) ? ` <span class="badge-fc" title="Called at least 70% of settled predictions right">Top forecaster</span>` : "";
  return `<div class="who">${avatar(p)}<div class="who-text"><span>${name}${badge}</span>${sub ? `<span class="meta">${sub}</span>` : ""}</div></div>`;
}
const topicLink = (t) => `<a class="topic" href="#/t/${esc(t)}">${esc(topicLabel(t))}</a>`;

const ICON = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  news: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h10M7 16h6"/>',
  chart: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  poll: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  q: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7M12 17h.01"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  up: '<path d="M12 5l7 8h-4v6H9v-6H5z"/>',
  down: '<path d="M12 19l-7-8h4V5h6v6h4z"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
};
const icon = (n, s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;
const LOGO = `<svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true"><rect width="34" height="34" rx="10" fill="#0F1222"/><path d="M6 19h5l3-8 5 14 3-7h6" fill="none" stroke="#19D3C5" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

let toastTimer;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), 3800);
}

/* ---------------------------------------------------------------- data */
async function getProfiles(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const map = new Map();
  if (!unique.length) return map;
  const { data } = await sb.from("profiles").select("id, username, display_name, avatar_url, reputation, is_banned").in("id", unique);
  for (const p of data || []) map.set(p.id, p);
  return map;
}

async function getFeed({ sort = "hot", topic, kind, subtype, q, page = 1, excludeNews = false }) {
  let query = sb.from("feed").select("*");
  if (topic) query = query.eq("topic", topic);
  if (kind) query = query.eq("kind", kind);
  if (subtype) query = query.eq("subtype", subtype);
  if (excludeNews) query = query.neq("kind", "story");
  if (q) query = query.ilike("title", `%${q.replace(/[%_,()]/g, " ")}%`);
  if (sort === "unanswered") query = query.eq("kind", "post").eq("subtype", "question").eq("comment_count", 0);
  query = sort === "new" || sort === "unanswered" ? query.order("created_at", { ascending: false }) : query.order("hot", { ascending: false });
  const from = (page - 1) * PAGE;
  const { data, error } = await query.range(from, from + PAGE);
  if (error) throw error;
  const rows = data || [];
  return { items: rows.slice(0, PAGE), hasMore: rows.length > PAGE };
}

async function feedExtras(items) {
  const pollIds = items.filter((i) => i.kind === "poll").map((i) => i.id);
  const postIds = items.filter((i) => i.kind === "post").map((i) => i.id);
  const questionIds = items.filter((i) => i.kind === "post" && i.subtype === "question" && i.comment_count > 0).map((i) => i.id);
  const uid = S.userId;
  const [polls, opts, myPoll, myPost, posts, answers] = await Promise.all([
    pollIds.length ? sb.from("polls").select("*").in("id", pollIds) : { data: [] },
    pollIds.length ? sb.from("poll_options").select("*").in("poll_id", pollIds).order("position") : { data: [] },
    uid && pollIds.length ? sb.from("poll_votes").select("poll_id, option_id").eq("user_id", uid).in("poll_id", pollIds) : { data: [] },
    uid && postIds.length ? sb.from("post_votes").select("post_id, value").eq("user_id", uid).in("post_id", postIds) : { data: [] },
    postIds.length ? sb.from("posts").select("id, is_editorial, best_comment_id").in("id", postIds) : { data: [] },
    Promise.all(questionIds.map(async (id) => {
      const { data } = await sb.from("comments").select("*").eq("target_type", "post").eq("target_id", id).is("parent_id", null)
        .order("score", { ascending: false }).order("created_at").limit(1);
      return [id, (data || [])[0] || null];
    })),
  ]);
  const options = new Map();
  for (const o of opts.data || []) options.set(o.poll_id, [...(options.get(o.poll_id) || []), o]);
  const topAnswers = new Map(answers.filter(([, c]) => c));
  const postInfo = new Map((posts.data || []).map((p) => [p.id, p]));
  const profiles = await getProfiles([...items.map((i) => i.author_id), ...[...topAnswers.values()].map((c) => c.author_id)]);
  return {
    profiles, options, topAnswers, postInfo,
    polls: new Map((polls.data || []).map((p) => [p.id, p])),
    myPoll: new Map((myPoll.data || []).map((v) => [v.poll_id, v.option_id])),
    myPost: new Map((myPost.data || []).map((v) => [v.post_id, v.value])),
  };
}

async function getComments(tt, tid) {
  const { data } = await sb.from("comments").select("*").eq("target_type", tt).eq("target_id", tid).order("created_at").limit(500);
  const comments = data || [];
  const [profiles, mine] = await Promise.all([
    getProfiles(comments.map((c) => c.author_id)),
    S.userId && comments.length ? sb.from("comment_votes").select("comment_id, value").eq("user_id", S.userId).in("comment_id", comments.map((c) => c.id)) : { data: [] },
  ]);
  return { comments, profiles, myVotes: new Map((mine.data || []).map((v) => [v.comment_id, v.value])) };
}

async function getRail() {
  if (S.rail && Date.now() - S.railAt < 60_000) return S.rail;
  const weekAgo = new Date(Date.now() - 7 * 24 * H).toISOString();
  const [trending, tickers, recent] = await Promise.all([
    sb.from("feed").select("kind, id, title").neq("kind", "story").gte("created_at", weekAgo).order("hot", { ascending: false }).limit(5),
    sb.from("tickers").select("symbol, name, comment_count").eq("active", true).order("comment_count", { ascending: false }).order("symbol").limit(6),
    sb.from("comments").select("author_id").gte("created_at", weekAgo).eq("status", "visible").limit(1000),
  ]);
  const counts = new Map();
  for (const c of recent.data || []) counts.set(c.author_id, (counts.get(c.author_id) || 0) + 1);
  const topIds = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const profiles = await getProfiles(topIds.map(([id]) => id));
  S.rail = { trending: trending.data || [], tickers: tickers.data || [], contributors: topIds.map(([id, n]) => ({ p: profiles.get(id), n })).filter((x) => x.p && !x.p.is_banned) };
  S.railAt = Date.now();
  return S.rail;
}

/* ---------------------------------------------------------------- cards */
function pollWidget(p, options, myVote) {
  const total = options.reduce((a, o) => a + o.vote_count, 0);
  const open = pollOpen(p);
  const show = Boolean(myVote) || !open;
  return `<div class="opts">${options.map((o) => {
    const pct = total ? Math.round((o.vote_count / total) * 100) : 0;
    const mine = myVote === o.id;
    const inner = `${show ? `<span class="bar" style="width:${pct}%"></span>` : ""}<span class="lbl"><span class="row" style="gap:6px">${mine ? icon("check", 16) : ""}${esc(o.label)}</span>${show ? `<span>${pct}%</span>` : ""}</span>`;
    if (!S.userId && open) return `<a class="opt" href="#/login">${inner}</a>`;
    return `<button type="button" class="opt ${mine ? "mine" : ""}" ${show ? "disabled" : ""} data-act="pollvote" data-poll="${p.id}" data-opt="${o.id}">${inner}</button>`;
  }).join("")}${!S.userId && open ? `<p class="meta">Log in to vote and see results.</p>` : !show ? `<p class="meta">Vote to see results.</p>` : ""}</div>`;
}
function pollMeta(p, author) {
  const status = p.status === "pending" ? "Waiting for review" : p.status === "rejected" ? "Rejected" : pollOpen(p) ? (left(p.closes_at) || "Open") : "Closed";
  return `<div class="row meta"><span class="chip c-hot">${p.origin === "auto" ? "Hot topic poll" : "Community poll"}</span><span>${p.origin === "auto" ? "Auto-generated from today's news" : "by " + esc(nameOf(author))} · ${plural(p.total_votes, "vote")} · ${status}</span></div>`;
}
function pollCard(item, x) {
  const p = x.polls.get(item.id);
  if (!p) return "";
  return `<article class="card pad stack">${pollMeta(p, x.profiles.get(p.author_id))}
    <h2 class="t-feed"><a class="title-link" href="#/polls/${p.id}">${esc(p.question)}</a></h2>
    ${p.description ? `<p class="body">${esc(p.description)}</p>` : ""}
    ${pollWidget(p, x.options.get(p.id) || [], x.myPoll.get(p.id) || null)}
    <a class="link" href="#/polls/${p.id}">Discuss why · ${plural(p.comment_count, "comment")}</a></article>`;
}
const STORY_TINT = { chips: ["#dbeafe", "#1e3a8a"], models: ["#e0e7ff", "#3730a3"], policy: ["#fef3c7", "#78350f"], agents: ["#ccfbf1", "#115e59"], funding: ["#fce7f3", "#9d174d"], jobs: ["#dcfce7", "#166534"], research: ["#ede9fe", "#5b21b6"], stocks: ["#ffedd5", "#9a3412"], building: ["#e0f2fe", "#075985"], general: ["#e9ecf3", "#343a4a"] };
function storyImage(id, topic, image) {
  const [bg, fg] = STORY_TINT[topic] || STORY_TINT.general;
  if (image) return `<a class="story-img has-img" href="#/news/${id}" tabindex="-1" aria-hidden="true"><img src="${esc(image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.classList.remove('has-img');this.remove()"></a>`;
  return `<a class="story-img" href="#/news/${id}" tabindex="-1" aria-hidden="true" style="background:${bg};color:${fg}">${esc(topicLabel(topic))}</a>`;
}
function hypeBar(s, mini = false) {
  const r = s.real_votes || 0, h = s.hype_votes || 0, t = r + h;
  if (!t) return mini ? "" : `<p class="meta">No hype ratings yet. Is this real substance or mostly hype?</p>`;
  const rp = Math.round((r / t) * 100);
  if (mini) return `<span class="hype-mini" title="${rp}% of ${t} readers say real substance"><span class="hype-bar" aria-hidden="true"><span class="real" style="width:${rp}%"></span><span class="fluff" style="width:${100 - rp}%"></span></span><span>${rp}% real</span></span>`;
  return `<div class="hype"><div class="hype-legend"><span>Hype meter</span><span class="meta" style="font-weight:500">${plural(t, "reader rating")}</span></div>
    <div class="hype-bar" role="img" aria-label="${rp}% real substance, ${100 - rp}% hype"><span class="real" style="width:${rp}%"></span><span class="fluff" style="width:${100 - rp}%"></span></div>
    <div class="hype-legend"><span class="r">${rp}% real substance</span><span class="h">${100 - rp}% hype</span></div></div>`;
}
function rateButtons(storyId, mine) {
  if (!S.userId) return `<a class="pill" style="align-self:flex-start" href="#/login">Log in to rate: real or hype?</a>`;
  return `<div class="row"><span class="meta" style="font-weight:600">Your call:</span>
    <button type="button" class="pill rate-btn real-on" aria-pressed="${mine === "real"}" data-act="rate" data-id="${storyId}" data-val="real" data-cur="${mine || ""}">Real substance</button>
    <button type="button" class="pill rate-btn hype-on" aria-pressed="${mine === "hype"}" data-act="rate" data-id="${storyId}" data-val="hype" data-cur="${mine || ""}">Mostly hype</button></div>`;
}
function storyCard(s) {
  const sources = Number(s.source_count ?? s.subtype ?? 1);
  return `<article class="card pad story">${storyImage(s.id, s.topic, s.image_url)}
    <div class="stack" style="gap:8px;flex:1 1 280px;min-width:0">
      <div class="row meta"><span class="chip c-news">AI News</span><span>${esc(topicLabel(s.topic))} · ${plural(sources, "source")} · ${ago(s.published_at || s.created_at)}</span></div>
      <h2 class="t-feed" style="font-size:19px"><a class="title-link" href="#/news/${s.id}">${esc(s.title)}</a></h2>
      ${(s.summary || s.excerpt) ? `<p class="body">${esc(s.summary || s.excerpt)}</p>` : ""}
      <div class="row" style="justify-content:space-between"><a class="link" href="#/news/${s.id}">Discuss · ${plural(s.comment_count, "comment")}</a>${s.real_votes != null ? hypeBar(s, true) : ""}</div>
    </div></article>`;
}
function postActions(id, isQ, score, myVote) {
  const on = myVote === 1;
  return `<div class="row">
    ${S.userId ? `<button type="button" class="pill ${on ? "pill-on" : ""}" aria-pressed="${on}" data-act="vote" data-kind="post" data-id="${id}" data-val="1" data-cur="${myVote || 0}">${icon("up", 16)}<span class="num">Upvote · ${fmt(score)}</span></button>`
      : `<a class="pill" href="#/login">${icon("up", 16)}<span class="num">Upvote · ${fmt(score)}</span></a>`}
    <a class="pill" href="#/p/${id}">${isQ ? "Answer" : "Reply"}</a>
  </div>`;
}
function postCard(item, x) {
  const isQ = item.subtype === "question";
  const info = x.postInfo.get(item.id) || {};
  const author = info.is_editorial ? EDITOR : x.profiles.get(item.author_id);
  const top = x.topAnswers.get(item.id);
  const best = top && info.best_comment_id === top.id;
  return `<article class="card pad stack">
    <div class="row meta"><span class="chip ${isQ ? "c-q" : "c-talk"}">${isQ ? "Question" : info.is_editorial ? "Discussion of the day" : "Discussion"}</span><span>${topicLink(item.topic)} · ${isQ ? plural(item.comment_count, "answer") : "posted by " + esc(nameOf(author)) + " · " + ago(item.created_at)}</span></div>
    <h2 class="t-feed"><a class="title-link" href="#/p/${item.id}">${esc(item.title)}</a></h2>
    ${top ? `${whoLine(x.profiles.get(top.author_id), best ? "Best answer" : "Top answer")}<p class="body clamp">${esc(top.body)}</p>` : item.excerpt ? `<p class="body clamp">${esc(item.excerpt)}</p>` : ""}
    ${isQ ? postActions(item.id, true, item.points, x.myPost.get(item.id)) : `<span class="meta">${plural(item.comment_count, "reply", "replies")} · ${plural(item.points, "upvote")}</span>`}
  </article>`;
}
function feedList(items, x, empty) {
  if (!items.length) return `<div class="card pad meta" style="text-align:center">${esc(empty || "Nothing here yet.")}</div>`;
  return items.map((it) => it.kind === "poll" ? pollCard(it, x) : it.kind === "story" ? storyCard(it) : postCard(it, x)).join("");
}
function tabs(key, list) {
  const cur = ui.sort[key] || list[0][0];
  return `<nav class="row" aria-label="Sort">${list.map(([id, l]) => `<button type="button" class="pill ${cur === id ? "on" : ""}" aria-pressed="${cur === id}" data-act="sort" data-key="${key}" data-val="${id}">${l}</button>`).join("")}</nav>`;
}
function pager(key, hasMore) {
  const page = ui.page[key] || 1;
  if (page <= 1 && !hasMore) return "";
  return `<div class="row between">${page > 1 ? `<button type="button" class="btn btn-o" data-act="page" data-key="${key}" data-val="${page - 1}">← Newer</button>` : "<span></span>"}${hasMore ? `<button type="button" class="btn btn-o" data-act="page" data-key="${key}" data-val="${page + 1}">More →</button>` : ""}</div>`;
}
async function feedSection(key, opts, empty) {
  const page = ui.page[key] || 1;
  const { items, hasMore } = await getFeed({ ...opts, page });
  const x = await feedExtras(items);
  return feedList(items, x, empty) + pager(key, hasMore);
}

/* ---------------------------------------------------------------- predictions + models */
const predOpen = (p) => p.status === "live" && new Date(p.closes_at).getTime() > Date.now();
const longDate = (d) => new Date(String(d).length === 10 ? d + "T12:00:00Z" : d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
function trendText(p) {
  if (p.crowd_prob == null) return "no forecasts yet";
  if (p.prob_week_ago == null) return "crowd says yes";
  const d = p.crowd_prob - p.prob_week_ago;
  return `crowd says yes · ${d > 0 ? "up " + d : d < 0 ? "down " + -d : "no change"} this week`;
}
function predStatusLine(p) {
  const base = `${plural(p.forecast_count, "forecast")}`;
  if (p.status === "resolved") return `Settled ${p.outcome ? "YES" : "NO"} · ${base}`;
  if (p.status === "void") return `Cancelled · ${base}`;
  if (p.status === "pending") return `Waiting for review`;
  return predOpen(p) ? `Resolves ${longDate(p.resolves_by)} · ${base}` : `Forecasting closed · waiting for the result`;
}
function forecastBox(p, mine) {
  if (p.status === "resolved") {
    return mine ? `<p class="fc-result ${mine.points >= 0 ? "good" : "bad"}">You said ${mine.prob}% · ${mine.points >= 0 ? "+" : ""}${mine.points} points</p>` : `<p class="meta">You didn't forecast this one.</p>`;
  }
  if (p.status === "void") return `<p class="meta">Cancelled: no points for anyone.</p>`;
  if (!predOpen(p)) return mine ? `<p class="meta">Your forecast: ${mine.prob}% yes. Points are added when it's settled.</p>` : `<p class="meta">Forecasting is closed.</p>`;
  if (!S.userId) return `<a class="pill" style="align-self:flex-start" href="#/login">Log in to make your forecast</a>`;
  const v = mine ? mine.prob : p.crowd_prob || 50;
  return `<form class="fc" data-form="forecast" data-id="${p.id}" data-has="${mine ? 1 : 0}">
    <label for="fc-${p.id}">Your forecast: <output id="fo-${p.id}">${v}% yes</output></label>
    <input type="range" id="fc-${p.id}" name="prob" min="1" max="99" value="${v}" data-out="fo-${p.id}">
    <div class="row between"><span class="meta">${mine ? "Saved. You can change it until it closes." : "Slide, then save."}</span><button class="btn btn-p btn-s">${mine ? "Update forecast" : "Save forecast"}</button></div>
  </form>`;
}
function predCard(p, mine, big = false) {
  return `<article class="card pad stack pred">
    <span class="eyebrow-mono">${predStatusLine(p)}</span>
    <${big ? "h1" : "h2"} class="pred-q"><a class="title-link" href="#/predict/${p.id}">${esc(p.question)}</a></${big ? "h1" : "h2"}>
    ${big && p.criteria ? `<p class="body"><b>Counts as YES if:</b> ${esc(p.criteria)}</p>` : ""}
    <div class="crowd"><b>${p.crowd_prob == null ? "–" : p.crowd_prob + "%"}</b><span>${trendText(p)}</span></div>
    ${p.status === "resolved" || p.status === "void" ? `<p class="note ${p.status === "resolved" ? (p.outcome ? "c-news" : "c-warn") : ""}"><b>${p.status === "void" ? "Cancelled" : "Result: " + (p.outcome ? "YES" : "NO")}</b>${p.resolution_note ? " · " + linkify(p.resolution_note) : ""}</p>` : ""}
    ${forecastBox(p, mine)}
    ${big ? "" : `<a class="link" href="#/predict/${p.id}">Why? Discuss · ${plural(p.comment_count, "comment")}</a>`}
  </article>`;
}
async function myForecasts(ids) {
  if (!S.userId || !ids.length) return new Map();
  const { data } = await sb.from("forecasts").select("prediction_id, prob, points").eq("user_id", S.userId).in("prediction_id", ids);
  return new Map((data || []).map((f) => [f.prediction_id, f]));
}
async function getLeaders(limit) {
  const { data } = await sb.from("profiles").select("id, username, display_name, avatar_url, forecast_points, forecasts_scored, forecasts_right")
    .gt("forecasts_scored", 0).eq("is_banned", false).order("forecast_points", { ascending: false }).limit(limit);
  return data || [];
}
const pctRight = (u) => Math.round((u.forecasts_right / Math.max(1, u.forecasts_scored)) * 100);
function leadersAside(leaders) {
  return `<aside class="leaders" aria-label="Best forecasters"><h3>Best forecasters</h3>
    ${leaders.length ? leaders.map((u, i) => `<a class="ldr" href="#/u/${esc(u.username)}"><span>${i + 1} · ${esc(nameOf(u))}</span><span>${pctRight(u)}% right</span></a>`).join("")
      : `<p style="margin:0;color:var(--dark-muted)">No predictions settled yet. Make your calls now to be first on the board.</p>`}
    <span class="small">Top forecasters (5+ settled calls, 70%+ right) get a badge next to their name everywhere on the site.</span>
    <a class="link-dark" href="#/predict/leaders">Full leaderboard →</a></aside>`;
}
const BEST_FOR = ["Coding", "Writing", "Research", "Chat", "Images", "Video", "Agents", "Voice", "Math", "Everyday"];
function trendArrow(m) {
  const d = m.mentions_week - m.mentions_prev_week;
  if (!m.mentions_prev_week && !m.mentions_week) return "";
  return d > 0 ? `<span class="up" title="Up from ${m.mentions_prev_week} last week">▲ ${d}</span>` : d < 0 ? `<span class="down" title="Down from ${m.mentions_prev_week} last week">▼ ${-d}</span>` : "";
}
const ratingText = (m) => (m.rating_count ? `${Number(m.rating_avg).toFixed(1)} / 5 <span class="meta">· ${fmt(m.rating_count)}</span>` : `<span class="meta">Not rated yet</span>`);
function modelTable(models, start = 0) {
  return `<div class="table-box"><table class="mx"><thead><tr><th>#</th><th>Model</th><th>Reader rating</th><th>Best for</th><th>Mentions this week</th></tr></thead><tbody>
    ${models.map((m, i) => `<tr><td class="mono">${start + i + 1}</td><td><a class="title-link" href="#/models/${m.id}"><b>${esc(m.name)}</b></a><div class="meta">${esc(m.maker)}</div></td>
      <td>${ratingText(m)}</td><td>${m.best_for ? `<span class="chip c-news">${esc(m.best_for)}</span>` : `<span class="meta">–</span>`}</td>
      <td class="mono">${fmt(m.mentions_week)} ${trendArrow(m)}</td></tr>`).join("")}
  </tbody></table></div>`;
}
const sortModels = (list, by) => [...list].sort(by === "news"
  ? (a, b) => b.mentions_week - a.mentions_week || a.name.localeCompare(b.name)
  : (a, b) => (b.rating_count ? 1 : 0) - (a.rating_count ? 1 : 0) || Number(b.rating_avg || 0) - Number(a.rating_avg || 0) || b.rating_count - a.rating_count || b.mentions_week - a.mentions_week);

/* ---------------------------------------------------------------- comments */
function commentForm(tt, tid, parent, placeholder) {
  const key = `${tt}|${tid}|${parent || ""}`;
  if (!S.userId) return `<p class="note" style="border:1px dashed var(--line);font-weight:500"><a class="link" href="#/login">Log in</a> to join the conversation.</p>`;
  if (me() && me().is_banned) return `<p class="note c-warn">Your account can't reply right now.</p>`;
  const id = "cf-" + key.replace(/[^a-z0-9]/gi, "");
  return `<form class="stack" style="gap:8px" data-form="comment" data-tt="${tt}" data-tid="${esc(tid)}" data-parent="${parent || ""}">
    <label class="sr" for="${id}">${esc(placeholder)}</label>
    <textarea class="field" id="${id}" name="body" rows="${parent ? 3 : 4}" maxlength="10000" placeholder="${esc(placeholder)}" required></textarea>
    <div class="row between"><p class="err" role="alert">${esc(ui.err[key] || "")}</p>
      <span class="row">${parent ? `<button type="button" class="btn btn-o btn-s" data-act="cancel-reply">Cancel</button>` : ""}<button class="btn btn-p btn-s">${parent ? "Post reply" : "Post"}</button></span></div>
  </form>`;
}
function reportBox(type, id) {
  return `<form class="box" style="margin-top:8px" data-form="report" data-type="${type}" data-id="${id}">
    <label class="label" for="rp-${id}">What's wrong with this?</label>
    <textarea class="field" id="rp-${id}" name="reason" rows="2" maxlength="500" placeholder="Spam, harassment, off-topic…"></textarea>
    <span class="row"><button class="btn btn-p btn-s">Send report</button><button type="button" class="btn btn-o btn-s" data-act="report-close">Cancel</button></span></form>`;
}
async function commentsSection(tt, tid, title, noun, placeholder, ctx = {}) {
  const { comments, profiles, myVotes } = await getComments(tt, tid);
  const kids = (pid) => comments.filter((c) => (c.parent_id || null) === pid);
  const roots = kids(null).sort((a, b) => (a.id === ctx.best ? -1 : b.id === ctx.best ? 1 : b.score - a.score || a.created_at.localeCompare(b.created_at)));
  const item = (c, depth) => {
    const a = profiles.get(c.author_id), mine = c.author_id === S.userId, mv = myVotes.get(c.id) || 0;
    const vote = S.userId
      ? `<button type="button" class="ghost ${mv === 1 ? "up-on" : ""}" aria-pressed="${mv === 1}" data-act="vote" data-kind="comment" data-id="${c.id}" data-val="1" data-cur="${mv}">${icon("up", 16)} Upvote · ${fmt(c.score)}</button><button type="button" class="ghost ${mv === -1 ? "down-on" : ""}" aria-pressed="${mv === -1}" aria-label="Downvote" data-act="vote" data-kind="comment" data-id="${c.id}" data-val="-1" data-cur="${mv}">${icon("down", 16)}</button>`
      : `<a class="ghost" href="#/login">${icon("up", 16)} Upvote · ${fmt(c.score)}</a>`;
    return `<div class="cm" id="c-${c.id}">
      <div class="row">${whoLine(a, `${ago(c.created_at)}${a ? " · " + plural(a.reputation, "point") : ""}`)}
        ${c.id === ctx.best ? `<span class="chip c-news">${icon("check", 14)} Best answer</span>` : ""}
        ${c.status !== "visible" ? `<span class="chip c-warn">${c.status === "flagged" ? "Waiting for review" : "Hidden by a moderator"}</span>` : ""}</div>
      <p class="body" style="margin-top:10px">${esc(c.body)}</p>
      <div class="row" style="gap:2px;margin-top:6px">${vote}
        ${S.userId && depth < 4 ? `<button type="button" class="ghost" data-act="reply" data-id="${c.id}">Reply</button>` : ""}
        ${ctx.canBest && depth === 0 ? `<button type="button" class="ghost" data-act="best" data-post="${ctx.postId}" data-id="${c.id === ctx.best ? "" : c.id}">${c.id === ctx.best ? "Unmark best" : "Mark as best answer"}</button>` : ""}
        ${mine ? (ui.confirm === "c-" + c.id ? `<span class="row meta" style="gap:4px">Delete this reply? <button type="button" class="ghost danger" data-act="del-comment" data-id="${c.id}">Delete</button><button type="button" class="ghost" data-act="unconfirm">Keep</button></span>` : `<button type="button" class="ghost" data-act="confirm" data-key="c-${c.id}">Delete</button>`)
          : S.userId ? `<button type="button" class="ghost" data-act="report-open" data-key="comment-${c.id}">${icon("flag", 15)} Report</button>` : ""}
      </div>
      ${ui.report === "comment-" + c.id ? reportBox("comment", c.id) : ""}
      ${ui.reply === c.id ? `<div class="inline-box">${commentForm(tt, tid, c.id, "Reply to " + nameOf(a) + "…")}</div>` : ""}
      ${kids(c.id).map((k) => item(k, depth + 1)).join("")}
    </div>`;
  };
  return `<section class="card pad stack" aria-label="${esc(title)}">
    <h2 class="section-h">${esc(title)} <span class="meta" style="font-size:16px;font-weight:600">· ${plural(comments.length, noun, noun === "reply" ? "replies" : noun + "s")}</span></h2>
    ${commentForm(tt, tid, null, placeholder)}
    <div>${roots.map((c) => item(c, 0)).join("")}</div></section>`;
}

/* ---------------------------------------------------------------- shell */
const NAV = [["", "Today"], ["news", "News"], ["predict", "Predict"], ["polls", "Polls"], ["discussions", "Debates"], ["questions", "Q&A"], ["models", "Models"], ["stocks", "Stocks"]];
function shell(route, content, rail, railHtml) {
  const p = me();
  const head = route[0] || "";
  const active = { p: null, t: null, u: null }[head] === null ? null : head;
  return `<header class="top"><div class="wrap top-in">
      <a class="logo" href="#/">${LOGO}${esc(SITE)}</a>
      <nav class="topnav" aria-label="Sections">${NAV.map(([id, l]) => `<a href="#/${id}" class="${active === id ? "on" : ""}" ${active === id ? 'aria-current="page"' : ""}>${l}</a>`).join("")}</nav>
      <form class="search search-sm" role="search" data-form="search"><span aria-hidden="true">${icon("search")}</span><label class="sr" for="q">Search</label><input id="q" name="q" type="search" placeholder="Search questions, news, polls" value="${esc(route[0] === "search" ? decodeURIComponent(route[1] || "") : "")}"></form>
      <div class="top-right">${p ? `
        <details class="menu"><summary aria-label="Account menu">${avatar(p, 40)}</summary><div class="menu-panel">
          <div style="padding:8px 12px"><div style="font-weight:700">${esc(nameOf(p))}</div><div class="meta">@${esc(p.username)}</div></div>
          <a href="#/u/${esc(p.username)}">Your profile</a><a href="#/settings">Settings</a>${p.is_admin ? `<a href="#/admin">Admin</a>` : ""}
          <button type="button" data-act="logout">Log out</button></div></details>
        <a class="btn btn-p" href="#/ask/question">Ask</a>` : `
        <a class="btn btn-p" href="#/login">Sign in</a>`}</div>
    </div></header>
    <div class="wrap"><div class="layout ${rail ? "" : head === "" ? "full" : "plain"}">
      <main class="main" id="main" tabindex="-1">${content}</main>
      ${rail ? railHtml : ""}
    </div></div>
    <footer class="footer"><div class="wrap"><p style="max-width:60ch">© ${new Date().getFullYear()} ${esc(SITE)}. News is summarized by AI from the linked sources. Polls, predictions and daily discussions are generated automatically. Predictions are for fun, with no money involved. Nothing here is investment advice.</p>
      <nav aria-label="Footer"><a href="#/guidelines">Community guidelines</a><a href="#/terms">Terms</a><a href="#/privacy">Privacy</a></nav></div></footer>`;
}
function railView(r) {
  return `<aside class="rail">
    <section class="card pad"><h2>Spaces</h2><div class="row">${NAV_SPACES.map((id) => `<a class="pill" style="height:36px;font-size:13px" href="#/t/${id}">${esc(topicLabel(id))}</a>`).join("")}</div></section>
    <section class="card pad"><h2>Trending topics</h2>${r.trending.map((t, i) => `<div class="list-row" style="justify-content:flex-start;align-items:flex-start"><span style="width:16px;font-weight:800;color:var(--accent)">${i + 1}</span><a class="title-link" style="font-size:14px;font-weight:600" href="#/${t.kind === "poll" ? "polls" : "p"}/${t.id}">${esc(t.title)}</a></div>`).join("") || `<p class="meta">Nothing trending yet. Start a discussion!</p>`}</section>
    <section class="card pad"><div class="row between" style="margin-bottom:6px"><h2 style="margin:0">AI stocks</h2><span class="meta">Most discussed</span></div>
      ${r.tickers.map((t) => `<a class="list-row" href="#/stocks/${t.symbol}"><b>${t.symbol}</b><span class="meta">${plural(t.comment_count, "comment")}</span></a>`).join("")}
      <a class="link" href="#/stocks" style="display:inline-block;margin-top:8px;font-size:14px">Open stock discussions →</a><p class="meta" style="margin-top:6px">Not investment advice.</p></section>
    ${r.contributors.length ? `<section class="card pad"><h2>Top contributors this week</h2><div class="stack">${r.contributors.map(({ p, n }) => `<a class="row" href="#/u/${esc(p.username)}" style="gap:10px;flex-wrap:nowrap">${avatar(p, 34)}<span style="flex:1;font-weight:600;font-size:14px;min-width:0">${esc(nameOf(p))}</span><span class="meta">${plural(n, "answer")}</span></a>`).join("")}</div></section>` : ""}
  </aside>`;
}
function header(title, text, action) {
  return `<header class="card pad row between" style="gap:12px"><div class="stack" style="gap:4px;min-width:0;flex:1 1 300px"><h1 class="h-page">${esc(title)}</h1><p class="lead">${esc(text)}</p></div>${action || ""}</header>`;
}
const notFound = () => `<div class="card pad stack"><h1 class="h-page">Page not found</h1><p class="lead">It may have been deleted, or the link is wrong.</p><a class="btn btn-p" style="align-self:flex-start" href="#/">Go to the homepage</a></div>`;
const needLogin = (next) => { sessionStorage.setItem("aipulse-next", next); return `<div class="card pad stack"><h1 class="h-page">Log in to continue</h1><p class="lead">You need an account to do that. It's free.</p><a class="btn btn-p" style="align-self:flex-start" href="#/login">Log in or join</a></div>`; };

/* ---------------------------------------------------------------- pages */
let pulsePeak = "";
function pulseChart(stories) {
  const now = Date.now(), hourMs = 3600e3;
  const start = now - 23 * hourMs - (now % hourMs);
  const counts = Array(24).fill(0);
  for (const s of stories) {
    const i = Math.floor((new Date(s.published_at || s.created_at).getTime() - start) / hourMs);
    if (i >= 0 && i < 24) counts[i]++;
  }
  const max = Math.max(4, ...counts);
  const top = Math.ceil(max / 4) * 4;
  const W = 640, Hh = 170, L = 34, R = 10, T = 12, B = 26, pw = W - L - R, ph = Hh - T - B;
  const x = (i) => L + (i * pw) / 23, y = (v) => T + ph - (v / top) * ph;
  const pts = counts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const peak = counts.indexOf(Math.max(...counts));
  const hourLabel = (i) => new Date(start + i * hourMs).toLocaleTimeString("en-US", { hour: "numeric" });
  pulsePeak = counts[peak] ? `Busiest hour: ${hourLabel(peak)}, ${counts[peak]} new stories` : "";
  const tick = (v) => `<line x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}" stroke="${v ? "#262B3D" : "#3A4058"}"/><text x="${L - 8}" y="${y(v) + 4}" fill="#9AA3B8" font-size="11" text-anchor="end" font-family="JetBrains Mono, monospace">${v}</text>`;
  const xl = [0, 6, 12, 18, 23].map((i) => `<text x="${x(i)}" y="${Hh - 6}" fill="#9AA3B8" font-size="11" text-anchor="${i === 0 ? "start" : i === 23 ? "end" : "middle"}" font-family="JetBrains Mono, monospace">${hourLabel(i)}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="AI stories per hour over the last 24 hours, peaking at ${counts[peak]} around ${hourLabel(peak)}">
    ${tick(0)}${tick(top / 2)}${tick(top)}
    <path d="M${pts.join(" L")} L${x(23).toFixed(1)},${y(0)} L${x(0)},${y(0)} Z" fill="#19D3C5" fill-opacity="0.16"/>
    <path d="M${pts.join(" L")}" fill="none" stroke="#19D3C5" stroke-width="2.5" stroke-linejoin="round"/>
    ${counts[peak] ? `<circle cx="${x(peak)}" cy="${y(counts[peak])}" r="5" fill="#FFB547"/>` : ""}
    ${xl}</svg>`;
}
async function homeData() {
  const since = new Date(Date.now() - 24 * 3600e3).toISOString();
  const [stories, editorial, poll, question, trending, tickers, preds, leaders, models] = await Promise.all([
    sb.from("news_stories").select("id, title, summary, topic, source_count, comment_count, real_votes, hype_votes, published_at, created_at")
      .eq("is_hidden", false).gte("created_at", since).order("source_count", { ascending: false }).limit(1000),
    sb.from("posts").select("id, title, body, comment_count, created_at, story_id").eq("is_editorial", true).eq("status", "visible").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("polls").select("*").eq("status", "live").order("total_votes", { ascending: false }).order("published_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("posts").select("id, title, comment_count, score, best_comment_id").eq("kind", "question").eq("status", "visible").order("score", { ascending: false }).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("feed").select("kind, id, title, comment_count").neq("kind", "story").gte("created_at", new Date(Date.now() - 7 * 24 * 3600e3).toISOString()).order("hot", { ascending: false }).limit(5),
    sb.from("tickers").select("symbol, comment_count").eq("active", true).order("comment_count", { ascending: false }).order("symbol").limit(5),
    sb.from("predictions").select("*").eq("status", "live").gt("closes_at", new Date().toISOString()).order("forecast_count", { ascending: false }).order("published_at", { ascending: false }).limit(2),
    getLeaders(3),
    sb.from("models").select("*").eq("active", true),
  ]);
  return { stories: stories.data || [], editorial: editorial.data, poll: poll.data, question: question.data, trending: trending.data || [], tickers: tickers.data || [],
    preds: preds.data || [], leaders, models: models.data || [] };
}
async function leadExtras(lead) {
  const [timeline, mine] = await Promise.all([
    sb.from("news_stories").select("id, title, published_at, created_at").eq("is_hidden", false).eq("topic", lead.topic).neq("id", lead.id)
      .gte("created_at", new Date(Date.now() - 14 * 24 * 3600e3).toISOString()).order("published_at", { ascending: false, nullsFirst: false }).limit(4),
    S.userId ? sb.from("story_ratings").select("value").eq("story_id", lead.id).eq("user_id", S.userId).maybeSingle() : { data: null },
  ]);
  return { timeline: timeline.data || [], mine: mine.data ? mine.data.value : null };
}
async function pageHome() {
  const sort = ui.sort.home || "foryou";
  const p = me();
  const ask = (t) => (p ? `#/ask/${t}` : "#/login");
  const opts = sort === "hot" ? { sort: "hot", excludeNews: true } : { sort: sort === "foryou" ? "hot" : sort };
  const firstPage = (ui.page.home || 1) === 1;
  let top = "";
  if (firstPage) {
    const d = await homeData();
    const { stories } = d;
    const lead = stories[0];
    const [extras, pollOpts, myPoll, answer, myFc] = await Promise.all([
      lead ? leadExtras(lead) : null,
      d.poll ? sb.from("poll_options").select("*").eq("poll_id", d.poll.id).order("position") : { data: [] },
      d.poll && S.userId ? sb.from("poll_votes").select("option_id").eq("poll_id", d.poll.id).eq("user_id", S.userId).maybeSingle() : { data: null },
      d.question && d.question.comment_count ? sb.from("comments").select("*").eq("target_type", "post").eq("target_id", d.question.id).is("parent_id", null).order("score", { ascending: false }).limit(1).maybeSingle() : { data: null },
      myForecasts(d.preds.map((x) => x.id)),
    ]);
    const answerer = answer.data ? (await getProfiles([answer.data.author_id])).get(answer.data.author_id) : null;
    const articles = stories.reduce((a, s) => a + (s.source_count || 1), 0);
    const topics = new Set(stories.map((s) => s.topic)).size;
    const brief = stories.slice(0, 3);

    const pulse = stories.length ? `<section class="pulse-row" aria-label="Today in AI">
      <div class="pulse">
        <div class="row between" style="align-items:baseline"><h1>Today's AI pulse</h1><span class="mono" style="font-size:12px;color:var(--dark-muted)">LAST 24 HOURS</span></div>
        <div class="stats"><span><b>${fmt(stories.length)}</b> <span>STORIES</span></span><span><b>${fmt(articles)}</b> <span>ARTICLES</span></span><span><b>${topics}</b> <span>TOPICS</span></span></div>
        <figure>${pulseChart(stories)}<figcaption>New AI stories per hour, from every source we track${pulsePeak ? ` · <span style="color:#FFB547">● ${pulsePeak}</span>` : ""}</figcaption></figure>
      </div>
      <aside class="card pad stack briefing" aria-label="60-second briefing">
        <div class="row" style="flex-wrap:nowrap;gap:14px"><span class="brief-icon" aria-hidden="true">${icon("news", 22)}</span>
          <div><h2 style="font-size:22px;font-weight:800">The 60-second briefing</h2><p class="meta">The ${brief.length} most-covered AI stories right now</p></div></div>
        <ol>${brief.map((s) => `<li><b>${esc(topicLabel(s.topic))}:</b> <a href="#/news/${s.id}">${esc(s.title)}</a></li>`).join("")}</ol>
        <a class="link" style="margin-top:auto" href="#/news">All AI news →</a>
      </aside>
    </section>` : `<section class="pulse"><h1>Today's AI pulse</h1><p style="color:var(--dark-muted)">The first news of the day is on its way. News is collected every 30 minutes.</p></section>`;

    const leadCard = lead ? `<section class="card pad lead-row">
      <article class="lead">
        <span class="eyebrow-mono">Top story · ${esc(topicLabel(lead.topic))} · ${plural(lead.source_count, "source")} · ${ago(lead.published_at || lead.created_at)}</span>
        <h2><a href="#/news/${lead.id}" class="title-link">${esc(lead.title)}</a></h2>
        ${lead.summary ? `<p class="body" style="font-size:18px;max-width:72ch">${esc(lead.summary)}</p>` : ""}
        ${hypeBar(lead)}
        ${rateButtons(lead.id, extras.mine)}
        <div class="row"><a class="btn btn-p" href="#/news/${lead.id}">Read and discuss · ${lead.comment_count}</a></div>
      </article>
      <aside class="timeline" aria-label="More on this topic">
        <h3>More in ${esc(topicLabel(lead.topic))}</h3>
        ${extras.timeline.length ? extras.timeline.map((t, i) => `<div class="tl-item"><div class="tl-rail"><span class="tl-dot ${i === 0 ? "on" : ""}"></span>${i < extras.timeline.length - 1 ? `<span class="tl-line"></span>` : ""}</div>
          <div class="tl-body"><span class="eyebrow-mono">${ago(t.published_at || t.created_at)}</span><a href="#/news/${t.id}">${esc(t.title)}</a></div></div>`).join("") : `<p class="meta">More stories on this topic will appear here.</p>`}
        <a class="link" href="#/t/${esc(lead.topic)}">Follow ${esc(topicLabel(lead.topic))} →</a>
      </aside>
    </section>` : "";

    const ed = d.editorial;
    const debate = ed ? `<article class="card pad stack debate">
        <span class="eyebrow-mono">Debate of the day · started by AI from today's news</span>
        <h2 style="font-size:26px;font-weight:800;line-height:1.15"><a href="#/p/${ed.id}" class="title-link">${esc(ed.title)}</a></h2>
        <p class="body clamp">${esc(ed.body)}</p>
        <a class="btn btn-p" style="align-self:flex-start" href="#/p/${ed.id}">Add your argument · ${plural(ed.comment_count, "reply", "replies")}</a>
      </article>` : "";
    const pl = d.poll;
    const pollCardHtml = pl ? `<article class="card pad stack">
        <span class="eyebrow-mono">Poll of the day · ${plural(pl.total_votes, "vote")} · ${left(pl.closes_at) || "open"}</span>
        <h2 style="font-size:22px;font-weight:800;line-height:1.2"><a href="#/polls/${pl.id}" class="title-link">${esc(pl.question)}</a></h2>
        ${pollWidget(pl, pollOpts.data || [], myPoll.data ? myPoll.data.option_id : null)}
        <a class="link" href="#/polls/${pl.id}">Explain your vote →</a>
      </article>` : "";
    const q = d.question;
    const questionCard = q ? `<article class="card pad stack">
        <span class="eyebrow-mono">Top question · ${plural(q.comment_count, "answer")}</span>
        <h2 style="font-size:24px;font-weight:800;line-height:1.2"><a href="#/p/${q.id}" class="title-link">${esc(q.title)}</a></h2>
        ${answer.data ? `${whoLine(answerer, answer.data.id === q.best_comment_id ? "Best answer" : "Top answer")}<p class="body clamp">${esc(answer.data.body)}</p>` : `<p class="meta">No answers yet. Be the first.</p>`}
        <div class="row">${postActions(q.id, true, q.score, 0)}</div>
      </article>` : "";
    const side = `<aside class="card pad stack">
        <h2 style="font-size:20px;font-weight:800">Trending this week</h2>
        ${d.trending.map((t, i) => `<div class="list-row" style="justify-content:flex-start;align-items:flex-start"><span class="mono" style="width:18px;color:var(--accent);font-weight:600">${i + 1}</span><a class="title-link" style="font-size:15px;font-weight:600" href="#/${t.kind === "poll" ? "polls" : "p"}/${t.id}">${esc(t.title)}</a></div>`).join("") || `<p class="meta">Nothing trending yet.</p>`}
        <h2 style="font-size:20px;font-weight:800;margin-top:8px">Stock debates</h2>
        <div class="row">${d.tickers.map((t) => `<a class="pill" style="height:36px;font-size:13px" href="#/stocks/${t.symbol}">${t.symbol} · ${t.comment_count}</a>`).join("")}</div>
        <p class="meta">Opinions only. Not investment advice.</p>
      </aside>`;
    const predSection = `<section class="stack" aria-label="Predictions">
      <div class="sec-head"><h2>Call it: predictions</h2><span class="meta">Free to play. Earn points when you're right. No money involved.</span></div>
      <div class="pred-row">
        <div class="pred-cards">${d.preds.length ? d.preds.map((x) => predCard(x, myFc.get(x.id))).join("") : `<div class="card pad stack"><p class="lead">New prediction questions are written from the news every few hours.</p><a class="link" href="#/predict">See all predictions →</a></div>`}</div>
        ${leadersAside(d.leaders)}
      </div></section>`;
    const topModels = sortModels(d.models, "rating").slice(0, 5);
    const modelSection = topModels.length ? `<section class="stack" aria-label="The Model Index">
      <div class="sec-head"><h2>The Model Index</h2><span class="meta">How readers rate the AI tools they actually use, and how often each is in the news</span></div>
      <div class="card pad stack">${modelTable(topModels)}<a class="link" href="#/models">Full index and rate the models you use →</a></div></section>` : "";
    top = `${pulse}${leadCard}${predSection}
      ${debate || pollCardHtml ? `<section class="grid2">${debate}${pollCardHtml}</section>` : ""}
      <section class="grid2">${questionCard}${side}</section>
      ${modelSection}
      <h2 class="section-title">From the community</h2>`;
  }
  return `${top}<section class="card pad stack" aria-label="Ask or share">
      <div class="row" style="gap:12px;flex-wrap:nowrap">${avatar(p, 40)}<a href="${ask("question")}" class="composer-input">What do you want to ask or share about AI?</a></div>
      <div class="row"><a class="btn btn-soft" href="${ask("question")}">Ask a question</a><a class="btn btn-soft" href="${ask("discussion")}">Start a discussion</a><a class="btn btn-soft" href="${ask("poll")}">Create a poll</a></div>
    </section>
    ${tabs("home", [["foryou", "For you"], ["hot", "Hot"], ["new", "New"], ["unanswered", "Unanswered"]])}
    ${await feedSection("home", opts, sort === "unanswered" ? "Every question has an answer." : "No posts yet. Be the first to ask something!")}`;
}
async function pageNews() {
  const t = ui.newsTopic;
  const page = ui.page.news || 1;
  let query = sb.from("news_stories").select("*").eq("is_hidden", false);
  if (t) query = query.eq("topic", t);
  const from = (page - 1) * PAGE;
  const { data } = await query.order("published_at", { ascending: false, nullsFirst: false }).range(from, from + PAGE);
  const rows = data || [];
  return `<header class="card pad stack"><h1 class="h-page">AI News</h1>
      <p class="lead">Stories from across the web, grouped and summarized by AI. Open any story to see the sources and join the discussion.</p>
      <div class="row"><button type="button" class="pill ${!t ? "on" : ""}" data-act="news-topic" data-val="">All</button>${TOPICS.map(([id, l]) => `<button type="button" class="pill ${t === id ? "on" : ""}" data-act="news-topic" data-val="${id}">${l}</button>`).join("")}</div></header>
    ${rows.length ? rows.slice(0, PAGE).map(storyCard).join("") : `<div class="card pad meta">No stories yet. News is collected automatically every 30 minutes.</div>`}
    ${pager("news", rows.length > PAGE)}`;
}
async function pageStory(id) {
  if (!isUuid(id)) return notFound();
  const { data: s } = await sb.from("news_stories").select("*").eq("id", id).maybeSingle();
  if (!s) return notFound();
  const [{ data: links }, { data: polls }, { data: talks }, myRating] = await Promise.all([
    sb.from("news_links").select("*").eq("story_id", id).order("published_at"),
    sb.from("polls").select("id, question, total_votes").contains("story_ids", [id]).in("status", ["live", "closed"]),
    sb.from("posts").select("id, title, comment_count").eq("story_id", id).eq("status", "visible"),
    S.userId ? sb.from("story_ratings").select("value").eq("story_id", id).eq("user_id", S.userId).maybeSingle() : { data: null },
  ]);
  document.title = s.title + " · " + SITE;
  return `<article class="card pad stack" style="gap:16px">
      <div class="row meta"><span class="chip c-news">AI News</span><span>${topicLink(s.topic)} · ${ago(s.published_at || s.created_at)}</span>${s.is_hidden ? `<span class="chip c-warn">Hidden</span>` : ""}</div>
      <h1 class="t-page">${esc(s.title)}</h1>
      ${s.image_url ? `<img src="${esc(s.image_url)}" alt="" referrerpolicy="no-referrer" style="max-height:360px;width:100%;object-fit:cover;border-radius:12px" onerror="this.remove()">` : ""}
      ${s.summary ? `<div class="summary-box"><p class="eyebrow">AI summary</p><p style="font-size:17px;color:var(--ink-2);margin-top:4px">${esc(s.summary)}</p></div>` : ""}
      ${hypeBar(s)}
      ${rateButtons(s.id, myRating.data ? myRating.data.value : null)}
      <div><h2 style="font-size:14px;font-weight:700;margin-bottom:4px">Read the full story · ${plural((links || []).length, "source")}</h2>
        ${(links || []).map((l) => `<a class="list-row" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer nofollow"><span class="stack" style="gap:0"><b style="font-size:14px">${esc(l.source_name)}</b><span style="color:var(--ink-2)">${esc(l.title)}</span></span><span class="meta">${icon("ext")}</span></a>`).join("")}</div>
    </article>
    ${(talks || []).length ? `<section class="card pad"><h2 class="section-h" style="font-size:16px;margin-bottom:6px">Discussion of the day</h2>${talks.map((p) => `<a class="list-row" href="#/p/${p.id}"><b>${esc(p.title)}</b><span class="meta">${plural(p.comment_count, "reply", "replies")}</span></a>`).join("")}</section>` : ""}
    ${(polls || []).length ? `<section class="card pad"><h2 class="section-h" style="font-size:16px;margin-bottom:6px">Polls about this story</h2>${polls.map((p) => `<a class="list-row" href="#/polls/${p.id}"><b>${esc(p.question)}</b><span class="meta">${plural(p.total_votes, "vote")}</span></a>`).join("")}</section>` : ""}
    ${await commentsSection("story", s.id, "Discussion", "reply", "What do you think about this news?")}`;
}
async function pageStocks() {
  const { data } = await sb.from("tickers").select("*").eq("active", true).order("symbol");
  return `${header("AI Stocks", "A discussion thread for each company at the center of AI. Tap a price link to see the latest quote. Not investment advice.")}
    <section class="card table-box"><table><caption class="sr">AI stocks</caption>
      <thead><tr><th>Company</th><th>Latest price</th><th class="right">Discussion</th></tr></thead>
      <tbody>${(data || []).map((t) => `<tr><td><a href="#/stocks/${t.symbol}" class="stack" style="gap:0"><b>${t.symbol}</b><span class="meta">${esc(t.name)}</span></a></td>
        <td><a class="link" style="font-size:14px" href="https://finance.yahoo.com/quote/${encodeURIComponent(t.symbol)}" target="_blank" rel="noopener noreferrer">See price ↗</a></td>
        <td class="right"><a class="link" href="#/stocks/${t.symbol}">${plural(t.comment_count, "comment")}</a></td></tr>`).join("")}</tbody></table></section>`;
}
async function pageTicker(sym) {
  const symbol = String(sym || "").toUpperCase();
  if (!/^[A-Z.]{1,10}$/.test(symbol)) return notFound();
  const { data: t } = await sb.from("tickers").select("*").eq("symbol", symbol).maybeSingle();
  if (!t) return notFound();
  const word = t.name.split(" ")[0].replace(/[%_,()]/g, "");
  const { data: related } = await sb.from("news_stories").select("id, title, published_at, created_at").eq("is_hidden", false)
    .or(`title.ilike.%${word}%,title.ilike.%${symbol}%`).order("published_at", { ascending: false }).limit(5);
  document.title = `${symbol} · ${t.name} · ${SITE}`;
  return `<header class="card pad row between" style="align-items:flex-end">
      <div><p class="eyebrow">${symbol}</p><h1 class="h-page">${esc(t.name)}</h1></div>
      <div class="row"><a class="btn btn-o" href="https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}" target="_blank" rel="noopener noreferrer">Price on Yahoo Finance ↗</a><a class="btn btn-o" href="https://www.google.com/finance/quote/${encodeURIComponent(symbol)}" target="_blank" rel="noopener noreferrer">Google Finance ↗</a></div>
      <p class="meta" style="width:100%">For information and discussion only. This is not investment advice.</p></header>
    ${(related || []).length ? `<section class="card pad"><h2 class="section-h" style="font-size:16px;margin-bottom:6px">Related AI news</h2>${related.map((s) => `<a class="list-row" href="#/news/${s.id}"><b>${esc(s.title)}</b><span class="meta">${ago(s.published_at || s.created_at)}</span></a>`).join("")}</section>` : ""}
    ${await commentsSection("ticker", symbol, symbol + " discussion", "reply", "What's your take on " + t.name + "?")}`;
}
async function pagePolls() {
  const sort = ui.sort.polls || "hot";
  return `${header("Polls", "Hot-topic polls are written from the day's biggest AI news. Members can create their own.", `<a class="btn btn-p" href="${S.userId ? "#/ask/poll" : "#/login"}">Create a poll</a>`)}
    ${tabs("polls", [["hot", "Popular"], ["new", "Newest"]])}
    ${await feedSection("polls", { kind: "poll", sort }, "No polls yet. New ones arrive every few hours.")}`;
}
async function pagePoll(id) {
  if (!isUuid(id)) return notFound();
  const [{ data: p }, { data: options }, mine] = await Promise.all([
    sb.from("polls").select("*").eq("id", id).maybeSingle(),
    sb.from("poll_options").select("*").eq("poll_id", id).order("position"),
    S.userId ? sb.from("poll_votes").select("option_id").eq("poll_id", id).eq("user_id", S.userId).maybeSingle() : { data: null },
  ]);
  if (!p) return notFound();
  const [authors, stories] = await Promise.all([
    getProfiles([p.author_id]),
    p.story_ids && p.story_ids.length ? sb.from("news_stories").select("id, title").in("id", p.story_ids) : { data: [] },
  ]);
  document.title = p.question + " · " + SITE;
  const published = p.status === "live" || p.status === "closed";
  return `<article class="card pad stack" style="gap:14px">${pollMeta(p, authors.get(p.author_id))}
      <h1 class="t-page" style="font-size:26px">${esc(p.question)}</h1>
      ${p.description ? `<p class="body" style="font-size:16px">${esc(p.description)}</p>` : ""}
      ${published ? pollWidget(p, options || [], mine.data ? mine.data.option_id : null) : `<p class="note c-warn">This poll is waiting for review. <a class="link" href="#/admin">Open admin</a></p>`}
      ${(stories.data || []).length ? `<div><h2 style="font-size:14px;font-weight:700">Based on</h2>${stories.data.map((s) => `<p><a class="link" style="font-size:14px" href="#/news/${s.id}">${esc(s.title)}</a></p>`).join("")}</div>` : ""}
    </article>
    ${published ? await commentsSection("poll", p.id, "Debate", "reply", "Explain your vote. What's your argument?") : ""}`;
}
async function pagePredict(sub) {
  if (sub && sub !== "leaders" && sub !== "settled") return pagePrediction(sub);
  const tab = sub || "open";
  const head = header("Predictions", "Make your call on what happens next in AI. Free to play: earn points when you're right. No money involved.",
    `<a class="btn btn-o" href="#/predict/leaders">Best forecasters</a>`);
  const tabsHtml = `<nav class="row" aria-label="Show">${[["", "Open"], ["settled", "Settled"], ["leaders", "Best forecasters"]].map(([id, l]) => `<a class="pill ${(id || "open") === tab ? "on" : ""}" href="#/predict${id ? "/" + id : ""}">${l}</a>`).join("")}</nav>`;
  const how = `<details class="card pad how"><summary><b>How points work</b></summary><p class="body">Slide to how likely you think YES is. When the question is settled: saying 50% earns 0 points; the more confident you were and right, the more you earn (up to +100); confident and wrong loses up to −300. So only be sure when you're sure. Your forecast stays private until the question is settled.</p></details>`;
  if (tab === "leaders") {
    const leaders = await getLeaders(50);
    return `${head}${tabsHtml}<section class="card pad">${leaders.length ? `<div class="table-box"><table><thead><tr><th>#</th><th>Forecaster</th><th>Points</th><th>Right</th><th>Settled calls</th></tr></thead><tbody>
      ${leaders.map((u, i) => `<tr><td class="mono">${i + 1}</td><td><a class="row" style="gap:10px;flex-wrap:nowrap" href="#/u/${esc(u.username)}">${avatar(u, 30)}<b>${esc(nameOf(u))}</b></a></td><td class="mono">${fmt(u.forecast_points)}</td><td class="mono">${pctRight(u)}%</td><td class="mono">${u.forecasts_scored}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="lead">No predictions have been settled yet. Make your calls now to be first on the board.</p>`}</section>${how}`;
  }
  const page = ui.page.predict || 1;
  let q = sb.from("predictions").select("*");
  q = tab === "settled" ? q.in("status", ["resolved", "void"]).order("resolved_at", { ascending: false })
    : q.eq("status", "live").order("forecast_count", { ascending: false }).order("published_at", { ascending: false });
  const { data } = await q.range((page - 1) * PAGE, page * PAGE);
  const rows = (data || []).slice(0, PAGE);
  const mine = await myForecasts(rows.map((x) => x.id));
  return `${head}${tabsHtml}${how}
    ${rows.length ? `<div class="pred-grid">${rows.map((x) => predCard(x, mine.get(x.id))).join("")}</div>` : `<div class="card pad meta" style="text-align:center">${tab === "settled" ? "Nothing settled yet." : "No open predictions right now. New ones are written from the news every few hours."}</div>`}
    ${pager("predict", (data || []).length > PAGE)}`;
}
async function pagePrediction(id) {
  if (!isUuid(id)) return notFound();
  const { data: p } = await sb.from("predictions").select("*").eq("id", id).maybeSingle();
  if (!p) return notFound();
  const [mine, stories] = await Promise.all([
    myForecasts([p.id]),
    p.story_ids && p.story_ids.length ? sb.from("news_stories").select("id, title").in("id", p.story_ids) : { data: [] },
  ]);
  document.title = p.question + " · " + SITE;
  const live = p.status !== "pending" && p.status !== "rejected";
  return `<a class="link" href="#/predict">← All predictions</a>
    ${predCard(p, mine.get(p.id), true)}
    ${(stories.data || []).length ? `<section class="card pad"><h2 style="font-size:14px;font-weight:700">Based on</h2>${stories.data.map((s) => `<p><a class="link" style="font-size:14px" href="#/news/${s.id}">${esc(s.title)}</a></p>`).join("")}</section>` : ""}
    ${live ? await commentsSection("prediction", p.id, "Discussion", "reply", "What makes you think so? Share your reasoning.") : `<p class="note c-warn">This prediction is waiting for review. <a class="link" href="#/admin">Open admin</a></p>`}`;
}
async function pageModels() {
  const by = ui.sort.models || "rating";
  const { data } = await sb.from("models").select("*").eq("active", true);
  const list = sortModels(data || [], by);
  return `${header("The Model Index", "How readers rate the AI tools they actually use, and how often each one is in the AI news this week. Open a model to rate it.")}
    ${tabs("models", [["rating", "Top rated"], ["news", "Most in the news"]])}
    <section class="card pad stack">${list.length ? modelTable(list) : `<p class="meta">No models yet.</p>`}
      <p class="meta">Ratings come from signed-in readers. "Mentions" counts this week's AI stories on ${esc(SITE)} that name the model; ▲▼ compares with last week.</p></section>`;
}
async function pageModel(id) {
  if (!/^[a-z0-9-]{2,40}$/.test(id || "")) return notFound();
  const { data: m } = await sb.from("models").select("*").eq("id", id).maybeSingle();
  if (!m) return notFound();
  const names = [m.name.split(" / ")[0], ...(m.aliases || [])].filter((a) => /^[\w .-]{2,40}$/.test(a));
  const [mine, related] = await Promise.all([
    S.userId ? sb.from("model_ratings").select("stars, best_for").eq("model_id", id).eq("user_id", S.userId).maybeSingle() : { data: null },
    names.length ? sb.from("news_stories").select("id, title, published_at, created_at").eq("is_hidden", false).or(names.map((n) => `title.ilike."*${n}*"`).join(",")).order("created_at", { ascending: false }).limit(8) : { data: [] },
  ]);
  const r = mine.data;
  document.title = m.name + " · Model Index · " + SITE;
  const form = !S.userId ? `<a class="pill" style="align-self:flex-start" href="#/login">Log in to rate ${esc(m.name)}</a>`
    : `<form class="stack" style="gap:12px" data-form="model-rate" data-id="${m.id}" data-has="${r ? 1 : 0}">
      <fieldset class="stars"><legend class="label">Your rating</legend>${[1, 2, 3, 4, 5].map((n) => `<input type="radio" id="st${n}" name="stars" value="${n}" ${r && r.stars === n ? "checked" : ""} required><label for="st${n}" title="${n} star${n > 1 ? "s" : ""}">${n}★</label>`).join("")}</fieldset>
      <div><label class="label" for="bf">What do you mostly use it for?</label><select class="field" id="bf" name="best_for"><option value="">Choose (optional)</option>${BEST_FOR.map((b) => `<option ${r && r.best_for === b ? "selected" : ""}>${b}</option>`).join("")}</select></div>
      <div><button class="btn btn-p btn-s">${r ? "Update rating" : "Save rating"}</button></div></form>`;
  return `<a class="link" href="#/models">← The Model Index</a>
    <article class="card pad stack" style="gap:14px">
      <span class="eyebrow-mono">Model Index · ${esc(m.maker)}</span>
      <h1 class="t-page">${esc(m.name)}</h1>
      <div class="mstats"><div><b>${m.rating_count ? Number(m.rating_avg).toFixed(1) : "–"}</b><span>reader rating · ${plural(m.rating_count, "rating")}</span></div>
        <div><b>${esc(m.best_for || "–")}</b><span>best for, say readers</span></div>
        <div><b>${fmt(m.mentions_week)}</b><span>stories this week ${trendArrow(m)}</span></div></div>
      ${m.url ? `<a class="link" href="${esc(m.url)}" target="_blank" rel="noopener noreferrer nofollow">Visit ${esc(m.name)} ↗</a>` : ""}
      ${form}
    </article>
    <section class="card pad"><h2 class="section-h" style="font-size:16px;margin-bottom:6px">${esc(m.name)} in the news</h2>${(related.data || []).map((s) => `<a class="list-row" href="#/news/${s.id}"><b>${esc(s.title)}</b><span class="meta">${ago(s.published_at || s.created_at)}</span></a>`).join("") || `<p class="meta">No recent stories.</p>`}</section>
    ${await commentsSection("model", m.id, "Reviews and tips", "reply", "How do you use " + m.name + "? What is it good or bad at?")}`;
}
async function pageKind(kind) {
  const isQ = kind === "question";
  const key = isQ ? "questions" : "discussions";
  const sort = ui.sort[key] || "hot";
  return `${header(isQ ? "Questions & Answers" : "Discussions", isQ ? "Ask anything about AI. The best answers rise to the top." : "Share news, opinions, projects and experiences with AI.", `<a class="btn btn-p" href="${S.userId ? "#/ask/" + kind : "#/login"}">${isQ ? "Ask a question" : "Start a discussion"}</a>`)}
    ${tabs(key, isQ ? [["hot", "Top"], ["new", "New"], ["unanswered", "Unanswered"]] : [["hot", "Hot"], ["new", "New"]])}
    ${await feedSection(key, { kind: "post", subtype: kind, sort }, isQ ? "No questions yet." : "No discussions yet. Start the first one!")}`;
}
async function pagePost(id, held) {
  if (!isUuid(id)) return notFound();
  const { data: p } = await sb.from("posts").select("*").eq("id", id).maybeSingle();
  if (!p) return notFound();
  const [authors, mine, story] = await Promise.all([
    getProfiles([p.author_id]),
    S.userId ? sb.from("post_votes").select("value").eq("post_id", id).eq("user_id", S.userId).maybeSingle() : { data: null },
    p.story_id ? sb.from("news_stories").select("id, title").eq("id", p.story_id).maybeSingle() : { data: null },
  ]);
  const a = p.is_editorial ? EDITOR : authors.get(p.author_id);
  const isQ = p.kind === "question", own = p.author_id && p.author_id === S.userId;
  document.title = p.title + " · " + SITE;
  return `${p.status === "flagged" ? `<p class="note c-warn" role="status">This post is waiting for a moderator to review it. Only you and the moderators can see it until then.</p>` : ""}
    ${p.status === "hidden" ? `<p class="note c-warn" role="status">This post was hidden by a moderator.</p>` : ""}
    <article class="card pad stack" style="gap:16px">
      <div class="row meta"><span class="chip ${isQ ? "c-q" : "c-talk"}">${isQ ? "Question" : p.is_editorial ? "Discussion of the day" : "Discussion"}</span>${topicLink(p.topic)}</div>
      <h1 class="t-page">${esc(p.title)}</h1>
      ${whoLine(a, p.is_editorial ? "Written by AI from today's news · " + ago(p.created_at) + " ago" : (isQ ? "Asked " : "Posted ") + ago(p.created_at) + " ago")}
      ${p.body ? `<div class="body" style="font-size:16px">${linkify(p.body)}</div>` : ""}
      ${story.data ? `<p class="meta">Based on: <a class="link" href="#/news/${story.data.id}">${esc(story.data.title)}</a></p>` : ""}
      <div class="row">${postActions(p.id, isQ, p.score, mine.data ? mine.data.value : 0)}
        ${own ? (ui.confirm === "p-" + p.id ? `<span class="row meta">Delete this post and its replies? <button type="button" class="ghost danger" data-act="del-post" data-id="${p.id}">Delete</button><button type="button" class="ghost" data-act="unconfirm">Keep</button></span>` : `<button type="button" class="ghost" data-act="confirm" data-key="p-${p.id}">Delete</button>`)
          : S.userId && !p.is_editorial ? `<button type="button" class="ghost" data-act="report-open" data-key="post-${p.id}">${icon("flag", 15)} Report</button>` : ""}</div>
      ${ui.report === "post-" + p.id ? reportBox("post", p.id) : ""}
    </article>
    ${p.status === "visible" ? await commentsSection("post", p.id, isQ ? "Answers" : "Replies", isQ ? "answer" : "reply", isQ ? "Write your answer…" : "Add to the discussion…", { best: isQ ? p.best_comment_id : null, canBest: isQ && own, postId: p.id }) : ""}`;
}
function linkify(text) {
  return String(text).split(/(https?:\/\/[^\s<>"')]+)/g).map((part) =>
    /^https?:\/\//.test(part) ? `<a class="link" href="${esc(part)}" target="_blank" rel="noopener noreferrer nofollow ugc">${esc(part)}</a>` : esc(part)).join("");
}
async function pageTopic(t) {
  if (!isTopic(t)) return notFound();
  const info = TOPICS.find((x) => x[0] === t);
  const key = "t-" + t, sort = ui.sort[key] || "hot";
  return `<header class="card pad"><p class="eyebrow">Space</p><h1 class="h-page">${esc(info[1])}</h1><p class="lead">${esc(info[2])}</p></header>
    ${tabs(key, [["hot", "Hot"], ["new", "New"]])}
    ${await feedSection(key, { topic: t, sort }, "Nothing in this space yet.")}`;
}
async function pageSearch(raw) {
  const q = decodeURIComponent(raw || "").trim().slice(0, 100);
  return `<header class="card pad"><h1 class="h-page">${q ? "Results for “" + esc(q) + "”" : "Search"}</h1></header>
    ${q ? await feedSection("search-" + q, { q, sort: "new" }, "No matches. Try different words.") : `<div class="card pad meta">Type something in the search box above.</div>`}`;
}
async function pageUser(username) {
  if (!/^[a-z0-9_]{3,24}$/.test(username || "")) return notFound();
  const { data: u } = await sb.from("profiles").select("*").eq("username", username).maybeSingle();
  if (!u) return notFound();
  const [{ data: posts }, { data: cms }] = await Promise.all([
    sb.from("posts").select("id, kind, title, created_at, comment_count, status").eq("author_id", u.id).order("created_at", { ascending: false }).limit(20),
    sb.from("comments").select("id, target_type, target_id, body, score, created_at").eq("author_id", u.id).order("created_at", { ascending: false }).limit(20),
  ]);
  const href = (c) => c.target_type === "post" ? "#/p/" + c.target_id : c.target_type === "story" ? "#/news/" + c.target_id : c.target_type === "poll" ? "#/polls/" + c.target_id
    : c.target_type === "prediction" ? "#/predict/" + c.target_id : c.target_type === "model" ? "#/models/" + c.target_id : "#/stocks/" + c.target_id;
  const p = me();
  document.title = nameOf(u) + " · " + SITE;
  return `<header class="card pad row" style="gap:18px">${avatar(u, 72)}
      <div style="flex:1 1 220px;min-width:0"><h1 class="h-page">${esc(nameOf(u))}</h1>
        <p class="meta">@${esc(u.username)} · ${plural(u.reputation, "point")} · joined ${new Date(u.created_at).toLocaleDateString("en-US", { month: "long", year: "numeric" })}</p>
        ${u.forecasts_scored ? `<p class="meta" style="margin-top:4px">Forecasting: ${plural(u.forecast_points, "point")} · ${u.forecasts_right} of ${u.forecasts_scored} calls right${isTopForecaster(u) ? ` <span class="badge-fc">Top forecaster</span>` : ""}</p>` : ""}
        ${u.bio ? `<p class="lead" style="margin-top:6px">${esc(u.bio)}</p>` : ""}
        ${u.is_banned ? `<p class="err" style="margin-top:6px">This account is suspended.</p>` : ""}</div>
      ${p && p.id === u.id ? `<a class="btn btn-o" href="#/settings">Edit profile</a>` : ""}
      ${p && p.is_admin && p.id !== u.id ? `<button type="button" class="btn btn-o" data-act="ban" data-id="${u.id}" data-val="${!u.is_banned}">${u.is_banned ? "Unsuspend" : "Suspend"}</button>` : ""}
    </header>
    <section class="card pad"><h2 class="section-h" style="margin-bottom:6px">Posts</h2>${(posts || []).map((x) => `<a class="list-row" href="#/p/${x.id}" style="flex-direction:column;align-items:flex-start;gap:4px"><span class="row meta"><span class="chip ${x.kind === "question" ? "c-q" : "c-talk"}">${x.kind === "question" ? "Question" : "Discussion"}</span>${ago(x.created_at)}${x.status !== "visible" ? ` · ${x.status === "flagged" ? "waiting for review" : "hidden"}` : ""}</span><b>${esc(x.title)}</b></a>`).join("") || `<p class="meta">No posts yet.</p>`}</section>
    <section class="card pad"><h2 class="section-h" style="margin-bottom:6px">Answers and replies</h2>${(cms || []).map((c) => `<a class="list-row" href="${href(c)}" style="flex-direction:column;align-items:flex-start;gap:2px"><span class="meta">${ago(c.created_at)} · ${plural(c.score, "upvote")}</span><span class="body clamp">${esc(c.body)}</span></a>`).join("") || `<p class="meta">Nothing yet.</p>`}</section>`;
}
function topicSelect(id) {
  return `<div><label class="label" for="${id}">Topic</label><select class="field" id="${id}" name="topic" required><option value="" disabled selected>Choose a topic</option>${TOPICS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></div>`;
}
async function pageAsk(type) {
  if (!S.userId) return needLogin("#/ask/" + type);
  const T = [["question", "Ask a question"], ["discussion", "Start a discussion"], ["poll", "Create a poll"]];
  let form;
  if (me() && me().is_banned) form = `<p class="note c-warn">Your account can't post right now.</p>`;
  else if (type === "poll") form = `<form class="stack" style="gap:16px" data-form="poll">
      <div><label class="label" for="pq">Question</label><input class="field" id="pq" name="question" maxlength="200" required placeholder="e.g. Will AI agents replace most customer support jobs by 2030?"></div>
      <div><label class="label" for="pd">Context (optional)</label><textarea class="field" id="pd" name="desc" rows="2" maxlength="600"></textarea></div>
      <fieldset style="border:0;padding:0;margin:0" class="stack"><legend class="label">Options</legend>
        ${Array.from({ length: ui.optCount }, (_, i) => `<label class="sr" for="po${i}">Option ${i + 1}</label><input class="field" id="po${i}" name="option" maxlength="80" ${i < 2 ? "required" : ""} placeholder="Option ${i + 1}">`).join("")}
        ${ui.optCount < 4 ? `<button type="button" class="link" style="border:0;background:none;padding:4px 0;cursor:pointer;align-self:flex-start" data-act="add-opt">+ Add option</button>` : ""}</fieldset>
      <div class="row" style="gap:16px;align-items:flex-start"><div style="flex:1 1 200px">${topicSelect("pt")}</div>
        <div style="flex:1 1 200px"><label class="label" for="pdays">Open for</label><select class="field" id="pdays" name="days"><option value="1">1 day</option><option value="3" selected>3 days</option><option value="7">7 days</option></select></div></div>
      <p class="err" role="alert">${esc(ui.err.ask || "")}</p>
      <div><button class="btn btn-p" ${ui.busy ? "disabled" : ""}>Create poll</button></div></form>`;
  else {
    const isQ = type === "question";
    form = `<form class="stack" style="gap:16px" data-form="post" data-kind="${type}">
      <div><label class="label" for="ptitle">${isQ ? "Your question" : "Title"}</label><input class="field" id="ptitle" name="title" minlength="8" maxlength="200" required placeholder="${isQ ? "e.g. Which AI coding assistant is best for beginners?" : "e.g. What I learned building with AI agents"}"></div>
      <div><label class="label" for="pbody">${isQ ? "Details (optional)" : "What do you want to say?"}</label><textarea class="field" id="pbody" name="body" rows="7" maxlength="20000" ${isQ ? "" : "required"} placeholder="${isQ ? "Add context that helps people answer." : "Share your view, experience or a link."}"></textarea></div>
      ${topicSelect("ptopic")}
      <p class="err" role="alert">${esc(ui.err.ask || "")}</p>
      <div><button class="btn btn-p" ${ui.busy ? "disabled" : ""}>${isQ ? "Post question" : "Post discussion"}</button></div></form>`;
  }
  return `<section class="card pad stack" style="gap:18px"><h1 class="h-page">Share something about AI</h1>
    <nav class="row" aria-label="Post type">${T.map(([id, l]) => `<a class="pill ${id === type ? "on" : ""}" href="#/ask/${id}" ${id === type ? 'aria-current="page"' : ""}>${l}</a>`).join("")}</nav>
    ${form}
    <p class="meta">Keep it about AI and be respectful. New posts are checked automatically. See the <a class="link" href="#/guidelines">community guidelines</a>.</p></section>`;
}
async function pageSettings() {
  if (!S.userId) return needLogin("#/settings");
  const p = me();
  return `<section class="card pad stack" style="gap:16px"><h1 class="h-page">Your profile</h1>
    <form class="stack" style="gap:16px" data-form="profile">
      <div><label class="label" for="eu">Username</label><input class="field" id="eu" name="username" value="${esc(p.username)}" required pattern="[a-zA-Z0-9_]{3,24}"><p class="meta" style="margin-top:4px">3–24 letters, numbers or underscores.</p></div>
      <div><label class="label" for="en">Display name</label><input class="field" id="en" name="name" maxlength="50" value="${esc(p.display_name || "")}"></div>
      <div><label class="label" for="eb">Bio</label><textarea class="field" id="eb" name="bio" rows="3" maxlength="300">${esc(p.bio || "")}</textarea></div>
      <p class="${ui.ok.profile ? "ok-msg" : "err"}" role="status">${esc(ui.ok.profile || ui.err.profile || "")}</p>
      <div><button class="btn btn-p">Save profile</button></div></form></section>`;
}
async function pageLogin() {
  if (S.userId) { location.hash = sessionStorage.getItem("aipulse-next") || "#/"; return ""; }
  return `<section class="card pad stack" style="gap:18px;max-width:460px;margin:0 auto;width:100%">
    <div><h1 class="h-page">Join ${esc(SITE)}</h1><p class="lead">Ask questions, vote in polls and discuss the latest in AI.</p></div>
    ${ui.ok.login ? `<div class="note c-news" role="status"><b>Check your email.</b><br>We sent a sign-in link to ${esc(ui.ok.login)}. Open it on this device to continue.</div>` : `
    <button type="button" class="btn btn-o" style="height:48px" data-act="google">
      <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
      Continue with Google</button>
    <div class="row meta" style="flex-wrap:nowrap;font-weight:700;letter-spacing:.08em"><span style="flex:1;height:1px;background:var(--line)"></span>OR<span style="flex:1;height:1px;background:var(--line)"></span></div>
    <form class="stack" data-form="login"><div><label class="label" for="email">Email</label><input class="field" id="email" name="email" type="email" autocomplete="email" required placeholder="you@example.com"></div>
      <p class="err" role="alert">${esc(ui.err.login || "")}</p>
      <button class="btn btn-p" style="height:48px" ${ui.busy ? "disabled" : ""}>${ui.busy ? "Sending…" : "Email me a sign-in link"}</button></form>`}
    <p class="meta">By continuing you agree to the <a class="link" href="#/terms">Terms</a> and <a class="link" href="#/privacy">Privacy Policy</a>.</p></section>`;
}
async function pageAdmin() {
  const p = me();
  if (!p || !p.is_admin) return `<div class="card pad stack"><h1 class="h-page">Admins only</h1><p class="lead">Log in with the admin account to open this page.</p></div>`;
  const [pending, fPosts, fComments, reports, live, sources, tickers, members, stories, pPreds, livePreds, allModels] = await Promise.all([
    sb.from("polls").select("*, poll_options(*)").eq("status", "pending").order("created_at", { ascending: false }),
    sb.from("posts").select("id, title, body, author_id").eq("status", "flagged").order("created_at", { ascending: false }).limit(50),
    sb.from("comments").select("id, body, author_id, target_type, target_id").eq("status", "flagged").order("created_at", { ascending: false }).limit(50),
    sb.from("reports").select("*").eq("status", "open").order("created_at", { ascending: false }).limit(50),
    sb.from("polls").select("id, question, total_votes").eq("status", "live").order("published_at", { ascending: false }).limit(15),
    sb.from("news_sources").select("*").order("name"),
    sb.from("tickers").select("*").order("symbol"),
    sb.from("profiles").select("id, username, display_name, avatar_url, reputation, is_admin, is_banned, created_at").order("created_at", { ascending: false }).limit(30),
    sb.from("news_stories").select("id, title, is_hidden, source_count, created_at").order("created_at", { ascending: false }).limit(15),
    sb.from("predictions").select("*").eq("status", "pending").order("created_at", { ascending: false }),
    sb.from("predictions").select("id, question, resolves_by, forecast_count, crowd_prob, criteria").eq("status", "live").order("resolves_by"),
    sb.from("models").select("*").order("name"),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const rep = reports.data || [];
  const [rPosts, rComments] = await Promise.all([
    rep.some((r) => r.target_type === "post") ? sb.from("posts").select("id, title, body").in("id", rep.filter((r) => r.target_type === "post").map((r) => r.target_id)) : { data: [] },
    rep.some((r) => r.target_type === "comment") ? sb.from("comments").select("id, body").in("id", rep.filter((r) => r.target_type === "comment").map((r) => r.target_id)) : { data: [] },
  ]);
  const text = new Map([...(rPosts.data || []).map((x) => [x.id, x.title + "\n" + x.body]), ...(rComments.data || []).map((x) => [x.id, x.body])]);
  const people = await getProfiles([...rep.map((r) => r.reporter_id), ...(fPosts.data || []).map((x) => x.author_id), ...(fComments.data || []).map((x) => x.author_id)]);
  const sec = (title, inner, count) => `<section class="card pad stack"><h2 class="section-h">${title}${count !== undefined ? ` <span class="meta" style="font-size:16px">· ${count}</span>` : ""}</h2>${inner}</section>`;
  const flagged = [...(fPosts.data || []).map((x) => ({ type: "post", id: x.id, text: x.title + "\n" + x.body, author: x.author_id })), ...(fComments.data || []).map((x) => ({ type: "comment", id: x.id, text: x.body, author: x.author_id }))];
  const actionsUrl = CONFIG.githubRepo ? `https://github.com/${CONFIG.githubRepo}/actions` : null;
  return `<header><h1 style="font-size:30px;font-weight:800">Admin</h1><p class="lead">Review polls, handle reports, and manage sources, tickers and members.</p></header>
    ${sec("Automation", `<p class="lead">Everything runs by itself on GitHub: news and moderation (including member reports) every 30 minutes; new polls, new predictions, settling predictions from the news and Model Index counts every 6 hours; and a "Discussion of the day" each morning. Nothing on this page needs your attention unless you want to step in.</p>
      ${actionsUrl ? `<a class="btn btn-o" style="align-self:flex-start" href="${esc(actionsUrl)}" target="_blank" rel="noopener noreferrer">Run jobs now on GitHub ↗</a>` : `<p class="meta">Add your repository name to docs/config.js to get a "Run jobs now" button here.</p>`}`)}
    ${sec("Polls waiting for review", (pending.data || []).map((x) => `<form class="box" data-form="approve" data-id="${x.id}">
        <p class="meta">${esc(topicLabel(x.topic))} · created ${ago(x.created_at)} ago</p>
        <label class="sr" for="aq-${x.id}">Question</label><input class="field" id="aq-${x.id}" name="question" value="${esc(x.question)}" style="font-weight:700">
        <label class="sr" for="ad-${x.id}">Context</label><textarea class="field" id="ad-${x.id}" name="desc" rows="2">${esc(x.description || "")}</textarea>
        <ul style="margin:0;padding-left:20px;color:var(--ink-2)">${[...x.poll_options].sort((a, b) => a.position - b.position).map((o) => `<li>${esc(o.label)}</li>`).join("")}</ul>
        <span class="row"><button class="btn btn-p btn-s">Approve and publish</button><button type="button" class="btn btn-o btn-s" data-act="poll-status" data-id="${x.id}" data-val="rejected">Reject</button></span></form>`).join("") || `<p class="meta">Nothing to review.</p>`, (pending.data || []).length)}
    ${sec("Predictions waiting for review", (pPreds.data || []).map((x) => `<form class="box" data-form="pred-review" data-id="${x.id}">
        <p class="meta">${esc(topicLabel(x.topic))} · resolves ${longDate(x.resolves_by)} · created ${ago(x.created_at)} ago</p>
        <label class="sr" for="pq-${x.id}">Question</label><input class="field" id="pq-${x.id}" name="question" value="${esc(x.question)}" style="font-weight:700">
        <label class="label" for="pc-${x.id}">Counts as YES if</label><textarea class="field" id="pc-${x.id}" name="criteria" rows="2">${esc(x.criteria || "")}</textarea>
        <span class="row"><button class="btn btn-p btn-s">Approve and publish</button><button type="button" class="btn btn-o btn-s" data-act="pred-reject" data-id="${x.id}">Reject</button></span></form>`).join("") || `<p class="meta">Nothing to review.</p>`, (pPreds.data || []).length)}
    ${sec("Settle predictions", `<p class="meta">The robot checks the news and settles these by itself (YES as soon as it's confirmed, NO a couple of days after the deadline, cancelled if still unclear 3 weeks later). You only need this if you want to settle one by hand.</p>
      ${(livePreds.data || []).map((x) => `<form class="box" data-form="pred-resolve" data-id="${x.id}">
        <p class="meta">${x.resolves_by <= today ? `<span class="chip c-warn">Due</span> ` : ""}Resolves ${longDate(x.resolves_by)} · ${plural(x.forecast_count, "forecast")} · crowd ${x.crowd_prob ?? "–"}%</p>
        <a class="title-link" style="font-weight:700" href="#/predict/${x.id}">${esc(x.question)}</a>
        ${x.criteria ? `<p class="meta">YES if: ${esc(x.criteria)}</p>` : ""}
        <div class="row"><label class="sr" for="po-${x.id}">Result</label><select class="field" style="flex:0 1 200px" id="po-${x.id}" name="outcome" required><option value="" selected disabled>Result…</option><option value="yes">YES, it happened</option><option value="no">NO</option><option value="void">Cancel (unclear)</option></select>
          <label class="sr" for="pn-${x.id}">Note</label><input class="field" style="flex:1 1 220px" id="pn-${x.id}" name="note" maxlength="600" placeholder="Short note with the source (optional)">
          <button class="btn btn-p btn-s">Settle</button></div></form>`).join("") || `<p class="meta">No open predictions.</p>`}`, (livePreds.data || []).filter((x) => x.resolves_by <= today).length + " due")}
    ${sec("Write a prediction", `<form class="stack" data-form="pred-create">
        <div><label class="label" for="ncq">Question (yes/no)</label><input class="field" id="ncq" name="question" minlength="10" maxlength="200" required placeholder="e.g. Will a new open-weight model beat the top closed model on a major benchmark by June 30?"></div>
        <div><label class="label" for="ncc">Counts as YES if</label><textarea class="field" id="ncc" name="criteria" rows="2" maxlength="800"></textarea></div>
        <div class="row" style="align-items:flex-end"><div style="flex:1 1 200px">${topicSelect("nct")}</div><div style="flex:1 1 200px"><label class="label" for="ncd">Resolves on</label><input class="field" id="ncd" name="date" type="date" required min="${today}"></div>
          <button class="btn btn-p">Publish prediction</button></div></form>`)}
    ${sec("Model Index", `<div class="row">${(allModels.data || []).map((m) => `<button type="button" class="pill" style="${m.active ? "" : "opacity:.5"}" aria-pressed="${m.active}" data-act="model-toggle" data-id="${m.id}" data-val="${!m.active}">${esc(m.name)}</button>`).join("")}</div><p class="meta">Tap a model to hide or show it.</p>
      <form class="row" data-form="model-add"><label class="sr" for="mn">Model name</label><input class="field" style="flex:1 1 150px" id="mn" name="name" required placeholder="Model name"><label class="sr" for="mm">Maker</label><input class="field" style="flex:1 1 130px" id="mm" name="maker" required placeholder="Company">
        <label class="sr" for="ma">Other names</label><input class="field" style="flex:2 1 200px" id="ma" name="aliases" placeholder="Other names in the news, comma-separated"><label class="sr" for="mu">Website</label><input class="field" style="flex:1 1 180px" id="mu" name="url" type="url" placeholder="https:// (optional)"><button class="btn btn-p">Add model</button></form>`)}
    ${sec("Flagged by automatic checks", flagged.map((f) => `<div class="box"><p class="meta">${f.type} by ${esc(nameOf(people.get(f.author)))}</p><p class="body clamp">${esc(f.text)}</p>
        <span class="row">${f.type === "post" ? `<a class="btn btn-o btn-s" href="#/p/${f.id}">Open</a>` : ""}<button type="button" class="btn btn-p btn-s" data-act="mod" data-type="${f.type}" data-id="${f.id}" data-val="visible">Approve</button><button type="button" class="btn btn-o btn-s" data-act="mod" data-type="${f.type}" data-id="${f.id}" data-val="hidden">Hide</button></span></div>`).join("") || `<p class="meta">Nothing flagged.</p>`, flagged.length)}
    ${sec("Reports from members", rep.map((r) => `<div class="box"><p class="meta">${r.target_type} · reported by ${esc(nameOf(people.get(r.reporter_id)))} ${ago(r.created_at)} ago · reason: <span style="color:var(--ink)">${esc(r.reason)}</span></p><p class="body clamp">${esc(text.get(r.target_id) || "(already deleted)")}</p>
        <span class="row"><button type="button" class="btn btn-p btn-s" data-act="mod" data-type="${r.target_type}" data-id="${r.target_id}" data-val="hidden" data-report="${r.id}">Hide it</button><button type="button" class="btn btn-o btn-s" data-act="dismiss" data-id="${r.id}">Dismiss</button></span></div>`).join("") || `<p class="meta">No open reports.</p>`, rep.length)}
    ${sec("Live polls", (live.data || []).map((x) => `<div class="list-row"><a class="title-link" style="font-size:14px" href="#/polls/${x.id}">${esc(x.question)} <span class="meta">· ${x.total_votes} votes</span></a><button type="button" class="btn btn-o btn-s" data-act="poll-status" data-id="${x.id}" data-val="closed">Close now</button></div>`).join("") || `<p class="meta">No live polls.</p>`)}
    ${sec("News sources", `<div class="table-box"><table><thead><tr><th>Source</th><th>Last checked</th><th>Status</th><th></th></tr></thead><tbody>${(sources.data || []).map((s) => `<tr><td><b>${esc(s.name)}</b><div class="meta" style="word-break:break-all">${esc(s.feed_url)}</div></td><td>${s.last_fetched_at ? ago(s.last_fetched_at) + " ago" : "never"}</td><td>${!s.active ? `<span class="meta">paused</span>` : s.last_error ? `<span class="err">${esc(s.last_error)}</span>` : `<span class="ok-msg">ok</span>`}</td><td class="right"><span class="row" style="justify-content:flex-end"><button type="button" class="btn btn-o btn-s" data-act="source-toggle" data-id="${s.id}" data-val="${!s.active}">${s.active ? "Pause" : "Resume"}</button><button type="button" class="btn btn-o btn-s" data-act="source-del" data-id="${s.id}">Remove</button></span></td></tr>`).join("")}</tbody></table></div>
      <form class="row" data-form="source"><label class="sr" for="sn">Source name</label><input class="field" style="flex:1 1 160px" id="sn" name="name" required placeholder="Source name"><label class="sr" for="su">RSS feed address</label><input class="field" style="flex:2 1 260px" id="su" name="url" type="url" required placeholder="https://example.com/feed.xml"><button class="btn btn-p">Add source</button></form>`)}
    ${sec("Stock tickers", `<div class="row">${(tickers.data || []).map((t) => `<button type="button" class="pill" style="${t.active ? "" : "opacity:.5"}" aria-pressed="${t.active}" data-act="ticker-toggle" data-id="${t.symbol}" data-val="${!t.active}">${t.symbol}</button>`).join("")}</div><p class="meta">Tap a ticker to hide or show it.</p>
      <form class="row" data-form="ticker"><label class="sr" for="ts">Symbol</label><input class="field" style="flex:1 1 120px;text-transform:uppercase" id="ts" name="symbol" required placeholder="Symbol, e.g. CRM"><label class="sr" for="tn">Company name</label><input class="field" style="flex:2 1 200px" id="tn" name="name" required placeholder="Company name"><button class="btn btn-p">Add ticker</button></form>`)}
    ${sec("Newest members", (members.data || []).map((u) => `<div class="list-row"><a class="row" href="#/u/${esc(u.username)}" style="flex-wrap:nowrap;min-width:0">${avatar(u, 30)}<b>${esc(nameOf(u))}</b><span class="meta">${plural(u.reputation, "point")}${u.is_admin ? " · admin" : ""}${u.is_banned ? " · suspended" : ""}</span></a>${u.id !== p.id ? `<button type="button" class="btn btn-o btn-s" data-act="ban" data-id="${u.id}" data-val="${!u.is_banned}">${u.is_banned ? "Unsuspend" : "Suspend"}</button>` : ""}</div>`).join(""))}
    ${sec("Latest stories", (stories.data || []).map((s) => `<div class="list-row"><a class="title-link" style="font-size:14px;${s.is_hidden ? "text-decoration:line-through;color:var(--muted)" : ""}" href="#/news/${s.id}">${esc(s.title)} <span class="meta">· ${s.source_count} sources · ${ago(s.created_at)}</span></a><button type="button" class="btn btn-o btn-s" data-act="story-hide" data-id="${s.id}" data-val="${!s.is_hidden}">${s.is_hidden ? "Show" : "Hide"}</button></div>`).join("") || `<p class="meta">No stories yet.</p>`)}`;
}
function prose(title, html) { return `<article class="card pad stack prose" style="gap:14px"><h1 style="font-size:28px;font-weight:800">${esc(title)}</h1>${html}</article>`; }
const pageGuidelines = () => prose("Community guidelines", `
  <p class="lead">${esc(SITE)} is a place to learn about and debate artificial intelligence. Strong opinions are welcome; keep them useful and respectful.</p>
  <h2 class="section-h">Do</h2><ul><li>Stay on topic: AI, the companies building it, and how it affects people, work and markets.</li><li>Argue with ideas, not people. Share sources when you can.</li><li>Upvote helpful answers, even when you disagree.</li><li>Say when you own a stock you discuss.</li></ul>
  <h2 class="section-h">Don't</h2><ul><li>Spam, advertise, or post referral links.</li><li>Harass, insult or threaten anyone, or post hateful or sexual content.</li><li>Share someone's private information.</li><li>Pump stocks or post misleading financial claims. Nothing here is investment advice.</li></ul>
  <h2 class="section-h">How moderation works</h2><p class="lead">New posts and replies are checked automatically. Anything that looks like it breaks these rules is held until a moderator reviews it. Members can report content, and moderators may hide content or suspend accounts.</p>`);
const pageTerms = () => prose("Terms of service", `
  <p class="meta">Last updated [DATE]. Starter text: have it reviewed before launch and fill in the bracketed details.</p>
  <p class="lead">These terms apply to your use of ${esc(SITE)}, operated by [YOUR NAME OR COMPANY], [YOUR CITY, STATE]. By using the site you agree to them.</p>
  <h2 class="section-h">Your account</h2><p class="lead">You must be at least 13 years old. Keep your login secure; you are responsible for activity on your account.</p>
  <h2 class="section-h">Your content</h2><p class="lead">You own what you post. By posting, you let us host and display it on the site. Follow the community guidelines; we may remove content or suspend accounts that don't.</p>
  <h2 class="section-h">AI-generated content</h2><p class="lead">News summaries, polls, predictions, prediction results and daily discussions are produced automatically by AI from third-party sources and may contain mistakes. Always check the original source. Predictions are a free game with no money or prizes.</p>
  <h2 class="section-h">Not financial advice</h2><p class="lead">Stock discussions are for information only. Nothing on the site is investment, legal or other professional advice.</p>
  <h2 class="section-h">Disclaimers</h2><p class="lead">The site is provided "as is" without warranties. To the extent the law allows, we are not liable for indirect or consequential losses from using it.</p>
  <h2 class="section-h">Contact</h2><p class="lead">[CONTACT EMAIL]</p>`);
const pagePrivacy = () => prose("Privacy policy", `
  <p class="meta">Last updated [DATE]. Starter text: have it reviewed before launch.</p>
  <h2 class="section-h">What we collect</h2><ul><li>Your email address and, if you sign in with Google, your name and profile picture.</li><li>What you post: questions, discussions, replies, votes, polls and reports.</li><li>Login cookies and basic technical data needed to run the site.</li></ul>
  <h2 class="section-h">How we use it</h2><ul><li>To run your account and show your posts.</li><li>To keep the site safe: posts are checked by automated AI moderation (Groq, or an open-source model run on GitHub).</li><li>We do not sell your personal information.</li></ul>
  <h2 class="section-h">Service providers</h2><p class="lead">GitHub (website hosting and scheduled jobs), Supabase (database and login) and Groq (AI summaries and moderation) process data on our behalf.</p>
  <h2 class="section-h">Your choices</h2><p class="lead">You can edit your profile and delete your posts and replies. To delete your account, email [CONTACT EMAIL].</p>`);

/* ---------------------------------------------------------------- router */
function route() {
  const h = location.hash.replace(/^#\/?/, "");
  return h.split("/").map((s) => s.trim());
}
let renderSeq = 0;
async function render({ keepScroll = false } = {}) {
  const seq = ++renderSeq;
  const r = route();
  const [head, a] = r;
  const y = window.scrollY;
  const focusId = document.activeElement && document.activeElement.id;
  let rail = true, page;
  if (!head || head === "ask" || head === "settings" || head === "login" || head === "admin" || head === "guidelines" || head === "terms" || head === "privacy") rail = false;
  if (!keepScroll) document.title = SITE + " — AI news, polls and discussion";
  try {
    if (!keepScroll && !app.querySelector(".main")) app.innerHTML = shell(r, `<div class="skeleton"></div><div class="skeleton"></div>`, false, "");
    const railPromise = rail ? getRail().then(railView).catch(() => "") : Promise.resolve("");
    page =
      !head ? await pageHome()
      : head === "news" ? (a ? await pageStory(a) : await pageNews())
      : head === "stocks" ? (a ? await pageTicker(a) : await pageStocks())
      : head === "polls" ? (a ? await pagePoll(a) : await pagePolls())
      : head === "predict" ? await pagePredict(a)
      : head === "models" ? (a ? await pageModel(a) : await pageModels())
      : head === "discussions" ? await pageKind("discussion")
      : head === "questions" ? await pageKind("question")
      : head === "p" ? await pagePost(a)
      : head === "t" ? await pageTopic(a)
      : head === "u" ? await pageUser(a)
      : head === "search" ? await pageSearch(a)
      : head === "ask" ? await pageAsk(["question", "discussion", "poll"].includes(a) ? a : "question")
      : head === "settings" ? await pageSettings()
      : head === "login" ? await pageLogin()
      : head === "admin" ? await pageAdmin()
      : head === "guidelines" ? pageGuidelines()
      : head === "terms" ? pageTerms()
      : head === "privacy" ? pagePrivacy()
      : notFound();
    const railHtml = await railPromise;
    if (seq !== renderSeq) return;
    app.innerHTML = shell(r, page, rail, railHtml);
  } catch (e) {
    console.error(e);
    if (seq !== renderSeq) return;
    app.innerHTML = shell(r, `<div class="card pad stack"><h1 class="h-page">Couldn't load this page</h1><p class="lead">${esc(errText(e))}</p><button type="button" class="btn btn-p" style="align-self:flex-start" data-act="retry">Try again</button></div>`, false, "");
  }
  if (keepScroll) {
    window.scrollTo(0, y);
    if (focusId && focusId !== "q") document.getElementById(focusId)?.focus({ preventScroll: true });
  } else window.scrollTo(0, 0);
}
const refresh = () => { S.railAt = 0; return render({ keepScroll: true }); };

/* ---------------------------------------------------------------- auth */
async function loadProfile() {
  const { data: { session } } = await sb.auth.getSession();
  S.userId = session ? session.user.id : null;
  S.profile = null;
  if (S.userId) {
    const { data } = await sb.from("profiles").select("*").eq("id", S.userId).maybeSingle();
    S.profile = data;
  }
}

/* ---------------------------------------------------------------- events */
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act, id = el.dataset.id, val = el.dataset.val;
  const run = async (promise, okMsg) => {
    const { error } = await promise;
    if (error) { toast(errText(error)); return false; }
    if (okMsg) toast(okMsg);
    await refresh();
    return true;
  };
  switch (act) {
    case "retry": return render();
    case "sort": ui.sort[el.dataset.key] = val; ui.page[el.dataset.key] = 1; return refresh();
    case "page": ui.page[el.dataset.key] = Number(val); return render();
    case "news-topic": ui.newsTopic = val; ui.page.news = 1; return refresh();
    case "confirm": ui.confirm = el.dataset.key; return refresh();
    case "unconfirm": ui.confirm = null; return refresh();
    case "reply": ui.reply = ui.reply === id ? null : id; await refresh(); document.querySelector(".inline-box textarea")?.focus(); return;
    case "cancel-reply": ui.reply = null; return refresh();
    case "report-open": ui.report = el.dataset.key; return refresh();
    case "report-close": ui.report = null; return refresh();
    case "add-opt": {
      const vals = [...document.querySelectorAll('[data-form="poll"] [id]')].map((x) => [x.id, x.value]);
      ui.optCount = Math.min(4, ui.optCount + 1); await refresh();
      vals.forEach(([k, v]) => { const n = document.getElementById(k); if (n) n.value = v; });
      return;
    }
    case "logout": await sb.auth.signOut(); return;
    case "google": {
      sessionStorage.setItem("aipulse-next", sessionStorage.getItem("aipulse-next") || "#/");
      const { error } = await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname } });
      if (error) toast(errText(error));
      return;
    }
    case "vote": {
      if (!S.userId) return (location.hash = "#/login");
      const table = el.dataset.kind === "post" ? "post_votes" : "comment_votes";
      const key = el.dataset.kind === "post" ? "post_id" : "comment_id";
      const next = Number(el.dataset.cur) === Number(val) ? 0 : Number(val);
      el.disabled = true;
      return run(next === 0
        ? sb.from(table).delete().eq(key, id).eq("user_id", S.userId)
        : sb.from(table).upsert({ [key]: id, user_id: S.userId, value: next }, { onConflict: `${key},user_id` }));
    }
    case "rate": {
      if (!S.userId) return (location.hash = "#/login");
      el.disabled = true;
      const cur = el.dataset.cur;
      return run(cur === val
        ? sb.from("story_ratings").delete().eq("story_id", id).eq("user_id", S.userId)
        : sb.from("story_ratings").upsert({ story_id: id, user_id: S.userId, value: val }, { onConflict: "story_id,user_id" }),
        cur === val ? "Rating removed." : val === "real" ? "Rated as real substance." : "Rated as mostly hype.");
    }
    case "pollvote":
      el.disabled = true;
      return run(sb.from("poll_votes").insert({ poll_id: el.dataset.poll, option_id: el.dataset.opt, user_id: S.userId }), "Vote counted.");
    case "best": return run(sb.rpc("set_best_answer", { p_post: el.dataset.post, p_comment: id || null }), id ? "Marked as the best answer." : "Best answer removed.");
    case "del-comment": ui.confirm = null; return run(sb.from("comments").delete().eq("id", id), "Reply deleted.");
    case "del-post": {
      ui.confirm = null;
      const { error } = await sb.from("posts").delete().eq("id", id);
      if (error) return toast(errText(error));
      toast("Post deleted."); location.hash = "#/"; return;
    }
    case "ban": return run(sb.rpc("set_banned", { p_user: id, p_banned: val === "true" }), val === "true" ? "Member suspended." : "Member can post again.");
    case "mod": {
      const ok = await run(sb.from(el.dataset.type === "post" ? "posts" : "comments").update({ status: val }).eq("id", id), val === "visible" ? "Approved." : "Hidden from members.");
      if (ok && el.dataset.report) { await sb.from("reports").update({ status: "resolved" }).eq("id", el.dataset.report); await refresh(); }
      return;
    }
    case "dismiss": return run(sb.from("reports").update({ status: "dismissed" }).eq("id", id), "Report dismissed.");
    case "poll-status": return run(sb.from("polls").update(val === "closed" ? { status: "closed", closes_at: new Date().toISOString() } : { status: val }).eq("id", id), val === "closed" ? "Poll closed." : "Poll rejected.");
    case "source-toggle": return run(sb.from("news_sources").update({ active: val === "true" }).eq("id", id));
    case "source-del": return run(sb.from("news_sources").delete().eq("id", id), "Source removed.");
    case "ticker-toggle": return run(sb.from("tickers").update({ active: val === "true" }).eq("symbol", id));
    case "pred-reject": return run(sb.rpc("review_prediction", { p_id: id, p_approve: false, p_question: null, p_criteria: null }), "Prediction rejected.");
    case "model-toggle": return run(sb.from("models").update({ active: val === "true" }).eq("id", id));
    case "story-hide": return run(sb.from("news_stories").update({ is_hidden: val === "true" }).eq("id", id), val === "true" ? "Story hidden." : "Story visible again.");
  }
});

document.addEventListener("submit", async (e) => {
  const f = e.target.closest("[data-form]");
  if (!f) return;
  e.preventDefault();
  const fd = new FormData(f);
  const kind = f.dataset.form;
  const button = f.querySelector("button:not([type=button])");
  if (button) button.disabled = true;
  try {
    if (kind === "search") {
      const q = String(fd.get("q") || "").trim();
      location.hash = q ? "#/search/" + encodeURIComponent(q) : "#/search";
      return;
    }
    if (kind === "login") {
      const email = String(fd.get("email") || "").trim();
      ui.err.login = ""; ui.busy = true; await refresh();
      const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
      ui.busy = false;
      if (error) ui.err.login = errText(error); else ui.ok.login = email;
      return refresh();
    }
    if (kind === "comment") {
      const key = `${f.dataset.tt}|${f.dataset.tid}|${f.dataset.parent || ""}`;
      const body = String(fd.get("body") || "").trim();
      if (!body) { ui.err[key] = "Write something first."; return refresh(); }
      const { data, error } = await sb.from("comments").insert({ target_type: f.dataset.tt, target_id: f.dataset.tid, parent_id: f.dataset.parent || null, body, author_id: S.userId }).select("status").single();
      if (error) { ui.err[key] = errText(error); return refresh(); }
      ui.err[key] = ""; ui.reply = null;
      toast(data.status === "visible" ? "Reply posted." : "Your reply is waiting for a moderator to review it.");
      return refresh();
    }
    if (kind === "report") {
      const { error } = await sb.from("reports").insert({ target_type: f.dataset.type, target_id: f.dataset.id, reason: String(fd.get("reason") || "").trim() || "No reason given", reporter_id: S.userId });
      ui.report = null;
      toast(error ? (error.code === "23505" ? "You already reported this." : errText(error)) : "Thanks. A moderator will review it.");
      return refresh();
    }
    if (kind === "post") {
      const title = String(fd.get("title") || "").trim(), body = String(fd.get("body") || "").trim(), topic = fd.get("topic");
      ui.err.ask = title.length < 8 ? "The title needs at least 8 characters." : !topic ? "Pick a topic." : "";
      if (ui.err.ask) return refresh();
      const { data, error } = await sb.from("posts").insert({ kind: f.dataset.kind, title, body, topic, author_id: S.userId }).select("id, status").single();
      if (error) { ui.err.ask = errText(error); return refresh(); }
      ui.err.ask = "";
      toast(data.status === "visible" ? "Posted." : "Your post is waiting for a moderator to review it.");
      location.hash = "#/p/" + data.id;
      return;
    }
    if (kind === "poll") {
      const { data, error } = await sb.rpc("create_user_poll", {
        p_question: String(fd.get("question") || ""), p_description: String(fd.get("desc") || ""),
        p_topic: String(fd.get("topic") || "general"), p_days: Number(fd.get("days") || 3),
        p_options: fd.getAll("option").map(String),
      });
      if (error) { ui.err.ask = errText(error); return refresh(); }
      ui.err.ask = ""; ui.optCount = 2; toast("Poll created.");
      location.hash = "#/polls/" + data;
      return;
    }
    if (kind === "profile") {
      const username = String(fd.get("username") || "").trim().toLowerCase();
      ui.ok.profile = ""; ui.err.profile = "";
      if (!/^[a-z0-9_]{3,24}$/.test(username)) { ui.err.profile = "Usernames use 3–24 letters, numbers or underscores."; return refresh(); }
      const { error } = await sb.from("profiles").update({ username, display_name: String(fd.get("name") || "").trim() || null, bio: String(fd.get("bio") || "").trim() || null }).eq("id", S.userId);
      if (error) ui.err.profile = error.code === "23505" ? "That username is taken." : errText(error);
      else { ui.ok.profile = "Saved."; await loadProfile(); }
      return refresh();
    }
    if (kind === "approve") {
      return void (await (async () => {
        const { error } = await sb.rpc("approve_poll", { p_poll: f.dataset.id, p_question: String(fd.get("question") || ""), p_description: String(fd.get("desc") || "") });
        toast(error ? errText(error) : "Poll published for 48 hours.");
        await refresh();
      })());
    }
    if (kind === "forecast") {
      if (!S.userId) { location.hash = "#/login"; return; }
      const prob = Math.min(99, Math.max(1, Number(fd.get("prob")) || 50));
      const { error } = f.dataset.has === "1"
        ? await sb.from("forecasts").update({ prob }).eq("prediction_id", f.dataset.id).eq("user_id", S.userId)
        : await sb.from("forecasts").insert({ prediction_id: f.dataset.id, user_id: S.userId, prob });
      toast(error ? errText(error) : `Forecast saved: ${prob}% yes.`);
      return refresh();
    }
    if (kind === "model-rate") {
      if (!S.userId) { location.hash = "#/login"; return; }
      const stars = Number(fd.get("stars")), best_for = String(fd.get("best_for") || "") || null;
      if (!stars) { toast("Pick 1 to 5 stars."); return; }
      const { error } = f.dataset.has === "1"
        ? await sb.from("model_ratings").update({ stars, best_for }).eq("model_id", f.dataset.id).eq("user_id", S.userId)
        : await sb.from("model_ratings").insert({ model_id: f.dataset.id, user_id: S.userId, stars, best_for });
      toast(error ? errText(error) : "Thanks for rating.");
      return refresh();
    }
    if (kind === "pred-review") {
      const { error } = await sb.rpc("review_prediction", { p_id: f.dataset.id, p_approve: true, p_question: String(fd.get("question") || ""), p_criteria: String(fd.get("criteria") || "") });
      toast(error ? errText(error) : "Prediction published.");
      return refresh();
    }
    if (kind === "pred-resolve") {
      const o = String(fd.get("outcome") || "");
      if (!o) { toast("Pick a result first."); return; }
      const { error } = await sb.rpc("resolve_prediction", { p_id: f.dataset.id, p_outcome: o === "void" ? null : o === "yes", p_note: String(fd.get("note") || "") });
      toast(error ? errText(error) : o === "void" ? "Prediction cancelled." : "Settled. Points added.");
      return refresh();
    }
    if (kind === "pred-create") {
      const { data, error } = await sb.rpc("create_prediction", { p_question: String(fd.get("question") || ""), p_criteria: String(fd.get("criteria") || ""), p_topic: String(fd.get("topic") || "general"), p_resolves_by: String(fd.get("date") || "") });
      if (error) { toast(errText(error)); return refresh(); }
      toast("Prediction published."); location.hash = "#/predict/" + data; return;
    }
    if (kind === "model-add") {
      const name = String(fd.get("name") || "").trim();
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
      const aliases = String(fd.get("aliases") || "").split(",").map((x) => x.trim()).filter(Boolean);
      const { error } = await sb.from("models").insert({ id, name, maker: String(fd.get("maker") || "").trim(), aliases: aliases.length ? aliases : [name], url: String(fd.get("url") || "").trim() || null });
      toast(error ? (error.code === "23505" ? "That model is already in the index." : errText(error)) : "Model added. Mentions are counted on the next 6-hour run.");
      return refresh();
    }
    if (kind === "source") {
      const { error } = await sb.from("news_sources").insert({ name: String(fd.get("name")).trim(), feed_url: String(fd.get("url")).trim() });
      toast(error ? errText(error) : "Source added. It will be read on the next news run.");
      return refresh();
    }
    if (kind === "ticker") {
      const { error } = await sb.from("tickers").insert({ symbol: String(fd.get("symbol")).trim().toUpperCase(), name: String(fd.get("name")).trim() });
      toast(error ? errText(error) : "Ticker added.");
      return refresh();
    }
  } finally {
    if (button && document.body.contains(button)) button.disabled = false;
  }
});

document.addEventListener("input", (e) => {
  const r = e.target.closest("input[data-out]");
  if (r) { const o = document.getElementById(r.dataset.out); if (o) o.textContent = r.value + "% yes"; }
});

/* ---------------------------------------------------------------- start */
window.addEventListener("hashchange", () => { ui.reply = null; ui.report = null; ui.confirm = null; ui.err = {}; ui.ok.profile = ""; render(); });
sb.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") {
    setTimeout(async () => {
      await loadProfile();
      if (event === "SIGNED_IN") {
        const next = sessionStorage.getItem("aipulse-next");
        sessionStorage.removeItem("aipulse-next");
        ui.ok.login = "";
        if (route()[0] === "login" || next) { location.hash = next || "#/"; return; }
      }
      if (event === "SIGNED_OUT") toast("You're logged out.");
      render({ keepScroll: true });
    }, 0);
  }
});
(async () => {
  const params = new URLSearchParams(location.search);
  if (params.has("code") || params.has("error_description")) {
    await sb.auth.getSession(); // finishes the sign-in from the email link or Google
    if (params.has("error_description")) setTimeout(() => toast("That sign-in link didn't work or has expired. Please try again."), 300);
    history.replaceState(null, "", location.pathname + location.hash);
  }
  await loadProfile();
  render();
})();
})();
