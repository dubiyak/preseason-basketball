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
// A rolling alias, not a pinned version. Pinned 2.5 models are already closed
// to new keys, and this job has to keep running unattended for months.
const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
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
        required: ["date", "dateText", "teams", "isOfficialLeagueGame"],
      },
    },
  },
  required: ["games"],
};

const PROMPT = `You extract basketball fixtures from a news article. The season is 2026-27; preseason runs August-September 2026.

Rules:
- Extract every scheduled game the article states. Do not infer games that are not there.
- A preseason game is anything that is NOT a regular-season league fixture: friendlies, preseason tournaments, national cups, supercups. Set isOfficialLeagueGame=true for regular-season league games so they can be filtered out — do not omit them.
- Copy club names EXACTLY as the article writes them, including sponsor prefixes. Do not translate or normalise.
- Only output a date when the article gives one that resolves to a real day. If it says "mid-September" or gives no date, leave date empty and put the wording in dateText.
- Never guess a time, arena or broadcaster. Empty means the article did not say.
- This tracks CLUBS only. A game involving a national team (Greece, Israel, Serbia...) is not a club game: set isNationalTeam=true so it can be filtered out.
- Results of games already played are not fixtures. Skip them.

Return only games. If the article contains none, return an empty array.`;

/** 503 and 429 are the free tier's normal weather, not a reason to give up. */
async function withRetry(fn, tries = 4) {
  let wait = 8000;
  for (let i = 0; i < tries; i++) {
    const out = await fn();
    if (!out.error || !/^(503|429|500)/.test(out.error)) return out;
    if (i === tries - 1) return out;
    await new Promise((r) => setTimeout(r, wait));
    wait *= 2;
  }
}

async function callModelOnce(text, title) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: PROMPT }] },
        contents: [{ parts: [{ text: `HEADLINE: ${title}\n\nARTICLE:\n${text}` }] }],
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

const callModel = (text, title) => withRetry(() => callModelOnce(text, title));

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

let games = 0, official = 0, national = 0, failed = 0;
for (const [i, c] of todo.entries()) {
  const text = await articleText(c.url);
  if (!text || text.length < 200) {
    cache.articles[c.url] = { ok: false, why: "no readable text", title: c.title };
    failed++;
    continue;
  }

  const { data, error } = await callModel(text, c.title);
  if (error) {
    // Not cached: a transient failure must be retried on the next run, not
    // remembered as "this article has no games".
    console.log(`  ! ${c.outlet} · ${error}`);
    failed++;
    await new Promise((r) => setTimeout(r, GAP_MS));
    continue;
  }

  const all = data.games || [];
  const found = all.filter((g) => !g.isOfficialLeagueGame && !g.isNationalTeam);
  official += all.filter((g) => g.isOfficialLeagueGame).length;
  national += all.filter((g) => !g.isOfficialLeagueGame && g.isNationalTeam).length;
  games += found.length;

  cache.articles[c.url] = {
    ok: true, title: c.title, outlet: c.outlet, published: c.published,
    readAt: new Date().toISOString(), games: found,
  };

  if (found.length) {
    console.log(`[${found.length}] ${c.outlet} · ${c.title.slice(0, 62)}`);
    for (const g of found.slice(0, 4)) {
      const who = g.homeTeam && g.awayTeam ? `${g.homeTeam} v ${g.awayTeam}` : (g.teams || []).join(" v ");
      console.log(`      ${g.date || g.dateText || "?"} ${g.time || ""} ${who}${g.tournament ? ` · ${g.tournament}` : ""}`);
    }
  }

  if (i < todo.length - 1) await new Promise((r) => setTimeout(r, GAP_MS));
}

fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
console.log(`\nfixtures extracted : ${games}`);
console.log(`league games skipped: ${official}`);
console.log(`national teams skipped: ${national}`);
console.log(`articles failed    : ${failed}`);
