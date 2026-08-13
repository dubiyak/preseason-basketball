/**
 * Turn candidate articles into structured fixtures.
 *
 * The collector decides which articles might contain games; this decides what
 * the games are. A model does the reading because the alternative is a parser
 * per site in eight languages, and because half of these announcements are
 * prose ("the squad travels to Belgrade next week to face...") rather than a
 * table.
 *
 * Results are cached by URL. An article is read once, ever — which is what
 * keeps a run cheap enough for a free tier, since most of what the collector
 * surfaces on any given day it already surfaced yesterday.
 */
import fs from "node:fs";
import path from "node:path";

const DATA = path.resolve(import.meta.dirname, "..", "data");
/**
 * The free tier allows 20 requests per DAY per model — measured, not assumed;
 * the first full run burned through it in minutes. Two things buy back the
 * headroom:
 *
 *   1. The quota is per model, so each of these carries its own bucket.
 *      Four models is 80 requests a day.
 *   2. Each request carries a batch of articles rather than one.
 *
 * 80 requests x BATCH articles is far more than a day's news. Rolling aliases
 * rather than pinned versions: gemini-2.5-flash is already closed to new keys,
 * and a job meant to run unattended for months cannot depend on one version.
 */
const MODELS = (process.env.GEMINI_MODELS || [
  "gemini-flash-latest",
  "gemini-flash-lite-latest",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview",
].join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const BATCH = Number(process.env.BATCH_SIZE || 5);
const UA = "Mozilla/5.0 (compatible; preseason-basketball/1.0; +https://github.com/dubiyak/preseason-basketball)";
// Free tier allows ~10 requests/minute. Stay under it rather than get throttled.
const GAP_MS = 6500;
const MAX_ARTICLES = Number(process.env.MAX_ARTICLES || 40);

/* ---------- key ---------- */
function loadKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const envFile = path.resolve(import.meta.dirname, "..", ".env");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i > 0 && line.slice(0, i).trim() === "GEMINI_API_KEY") return line.slice(i + 1).trim();
    }
  }
  return null;
}
const KEY = loadKey();
if (!KEY) {
  console.error("No GEMINI_API_KEY (env or .env). Collection still works; extraction does not.");
  process.exit(1);
}

/* ---------- article text ---------- */
async function articleText(url) {
  let html;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
    if (!res.ok) return null;
    html = await res.text();
  } catch { return null; }

  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim()
    .slice(0, 14000);
}

/* ---------- schema ---------- */
// A hard schema is the point: the model cannot answer in prose, and a missing
// field comes back null rather than invented.
const SCHEMA = {
  type: "object",
  properties: {
    games: {
      type: "array",
      items: {
        type: "object",
        properties: {
          articleIndex: { type: "integer", description: "the number of the ARTICLE block this game came from" },
          date: { type: "string", description: "ISO yyyy-mm-dd, or empty string if the article gives no resolvable date" },
          dateText: { type: "string", description: "the date exactly as written in the article" },
          time: { type: "string", description: "HH:MM local, or empty" },
          homeTeam: { type: "string", description: "club named as playing at home, exactly as written; empty if the article does not say" },
          awayTeam: { type: "string", description: "the visiting club, exactly as written; empty if not stated" },
          teams: { type: "array", items: { type: "string" }, description: "both clubs as written, when home/away is not distinguishable" },
          opponentUndecided: { type: "boolean", description: "true when the article says the opponent is not yet known" },
          arena: { type: "string" },
          city: { type: "string" },
          country: { type: "string" },
          tournament: { type: "string", description: "name of the tournament or cup, empty for a standalone friendly" },
          broadcaster: { type: "string", description: "TV channel or streaming service named in the article, else empty" },
          broadcastUrl: { type: "string" },
          isOfficialLeagueGame: { type: "boolean", description: "true if this is a regular-season league game rather than a preseason game" },
          isNationalTeam: { type: "boolean", description: "true if either side is a national team rather than a club" },
          closedDoors: { type: "boolean" },
        },
        required: ["articleIndex", "date", "dateText", "teams", "isOfficialLeagueGame"],
      },
    },
  },
  required: ["games"],
};

const PROMPT = `You extract basketball fixtures from news articles. The season is 2026-27; preseason runs August-September 2026.

You are given several numbered ARTICLE blocks. Treat each one independently and never carry information from one into another. Every game you return must set articleIndex to the number of the block it came from.

Rules:
- Extract every scheduled game the article states. Do not infer games that are not there.
- A preseason game is anything that is NOT a regular-season league fixture: friendlies, preseason tournaments, national cups, supercups. Set isOfficialLeagueGame=true for regular-season league games so they can be filtered out — do not omit them.
- Copy club names EXACTLY as the article writes them, including sponsor prefixes. Do not translate or normalise.
- Only output a date when the article gives one that resolves to a real day. If it says "mid-September" or gives no date, leave date empty and put the wording in dateText.
- Never guess a time, arena or broadcaster. Empty means the article did not say.
- This tracks CLUBS only. A game involving a national team (Greece, Israel, Serbia...) is not a club game: set isNationalTeam=true so it can be filtered out.
- Results of games already played are not fixtures. Skip them.

Return only games. If the article contains none, return an empty array.`;

// Models whose daily quota is spent. Once emptied there is nothing to do but
// stop and leave the rest for the next run — the cache means no work is lost.
const spent = new Set();

async function callModelOnce(model, text) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: PROMPT }] },
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: SCHEMA,
        },
      }),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    return { error: `${res.status} ${body.slice(0, 160)}` };
  }
  const j = await res.json();
  const raw = j?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) return { error: "empty response" };
  try { return { data: JSON.parse(raw) }; }
  catch { return { error: "unparseable json" }; }
}

/**
 * Try each model that still has quota. A 429 retires that model for the run
 * and moves to the next; a 503 is transient load, so back off and try again.
 */
async function callModel(text) {
  for (const model of MODELS) {
    if (spent.has(model)) continue;
    let wait = 8000;
    for (let attempt = 0; attempt < 3; attempt++) {
      const out = await callModelOnce(model, text);
      if (!out.error) return { ...out, model };
      if (/^429/.test(out.error)) { spent.add(model); break; }
      if (!/^(503|500)/.test(out.error)) return out;
      await new Promise((r) => setTimeout(r, wait));
      wait *= 2;
    }
  }
  return { error: "all models out of quota", exhausted: true };
}

/* ---------- run ---------- */
const cachePath = path.join(DATA, "extracted.json");
const cache = fs.existsSync(cachePath)
  ? JSON.parse(fs.readFileSync(cachePath, "utf8"))
  : { articles: {} };

const { candidates } = JSON.parse(fs.readFileSync(path.join(DATA, "candidates.json"), "utf8"));
const unread = candidates.filter((c) => !cache.articles[c.url]);
const todo = unread.slice(0, MAX_ARTICLES);

console.log(
  `candidates ${candidates.length} · cached ${candidates.length - unread.length} · reading ${todo.length}` +
  (unread.length > todo.length ? ` · deferred ${unread.length - todo.length} (MAX_ARTICLES)` : "")
);

let games = 0, official = 0, national = 0, failed = 0, stopped = false;

// Fetch first, batch second: an article with no readable text must not take up
// a slot in a batch, and fetching is free.
const fetched = [];
for (const c of todo) {
  const text = await articleText(c.url);
  if (!text || text.length < 200) {
    cache.articles[c.url] = { ok: false, why: "no readable text", title: c.title };
    failed++;
    continue;
  }
  fetched.push({ ...c, text });
}

for (let i = 0; i < fetched.length; i += BATCH) {
  const batch = fetched.slice(i, i + BATCH);
  const prompt = batch
    .map((a, n) => `ARTICLE ${n}\nHEADLINE: ${a.title}\nTEXT:\n${a.text}`)
    .join("\n\n-----\n\n");

  const { data, error, exhausted, model } = await callModel(prompt);
  if (error) {
    // Deliberately not cached: a throttled call must be retried next run, not
    // remembered as "these articles have no games".
    console.log(`  ! batch of ${batch.length} · ${error.slice(0, 90)}`);
    failed += batch.length;
    if (exhausted) { stopped = true; break; }
    continue;
  }

  const all = data.games || [];
  for (const [n, a] of batch.entries()) {
    const mine = all.filter((g) => g.articleIndex === n);
    const found = mine.filter((g) => !g.isOfficialLeagueGame && !g.isNationalTeam);
    official += mine.filter((g) => g.isOfficialLeagueGame).length;
    national += mine.filter((g) => !g.isOfficialLeagueGame && g.isNationalTeam).length;
    games += found.length;

    cache.articles[a.url] = {
      ok: true, title: a.title, outlet: a.outlet, published: a.published,
      readAt: new Date().toISOString(), model, games: found,
    };

    if (found.length) {
      console.log(`[${found.length}] ${a.outlet} · ${a.title.slice(0, 60)}`);
      for (const g of found.slice(0, 4)) {
        const who = g.homeTeam && g.awayTeam ? `${g.homeTeam} v ${g.awayTeam}` : (g.teams || []).join(" v ");
        console.log(`      ${g.date || g.dateText || "?"} ${g.time || ""} ${who}${g.tournament ? ` · ${g.tournament}` : ""}`);
      }
    }
  }
  await new Promise((r) => setTimeout(r, GAP_MS));
}

fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
console.log(`\nfixtures extracted    : ${games}`);
console.log(`league games skipped  : ${official}`);
console.log(`national teams skipped: ${national}`);
console.log(`articles failed       : ${failed}`);
console.log(`models spent today    : ${[...spent].join(", ") || "none"}`);
if (stopped) console.log(`stopped early — quota exhausted; the rest are cached as unread and resume next run`);
