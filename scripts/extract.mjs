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
import { get, toText } from "../lib/fetch.mjs";

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
// Shared fetch: a browser User-Agent, because club sites refuse the polite one,
// and a text pass that keeps table cells apart. Hapoel Tel Aviv's fixture list
// collapsed into dates with no opponents until cell boundaries survived.
async function articleText(url) {
  const html = await get(url, { timeout: 25000 });
  return html ? toText(html, 16000) : null;
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
          broadcaster: { type: "string", description: "TV channel or streaming service named as showing this game, else empty" },
          broadcastUrl: { type: "string", description: "direct link to the stream or broadcast page, else empty" },
          played: { type: "boolean", description: "true if this game has already been played and a result is given" },
          homeScore: { type: "integer", description: "final score of the home side, only when played" },
          awayScore: { type: "integer", description: "final score of the away side, only when played" },
          statsUrl: { type: "string", description: "link to a boxscore or statistics page for this game, else empty" },
          reportUrl: { type: "string", description: "link to a match report or recap of this game, else empty" },
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

const PROMPT = `You extract BASKETBALL fixtures. The season is 2026-27; preseason runs August-September 2026.

Many European clubs are multi-sport. fcbarcelona.com and Real Madrid's site list football alongside basketball. If a page is about football, handball or any other sport, return nothing for it — a football fixture at Camp Nou is not a miss, it is the wrong sport. Return only games between basketball teams.

This tracks MEN'S basketball only. Women's competitions are often published on the same sites and look identical: "Liga Femenina", "Supercopa LF Endesa", "baloncesto femenino", "EuroLeague Women", "female", "kadınlar", "γυναικών". Return nothing for those.

A page of PAST results is not a fixture list. Competition sites keep a history — acb.com/supercopa lists every previous final. Only take games from the 2026-27 season; if a page is showing earlier seasons, return nothing for it.

You are given several numbered ARTICLE blocks. Treat each one independently and never carry information from one into another. Every game you return must set articleIndex to the number of the block it came from.

Rules:
- Extract every scheduled game the article states. Do not infer games that are not there.
- isOfficialLeagueGame=true means the game counts towards a competition's standings or knockout: a domestic league round, and every EuroLeague, EuroCup, Basketball Champions League, ABA Liga or VTB fixture including their group stages and playoffs. Set it and do not omit the game — it is filtered out later.
- isOfficialLeagueGame=false is everything else: friendlies, preseason tournaments and memorials, national cups, supercups, and regional cups. These are what this project collects.
- The season's official competitions start in late September. A game in August or the first three weeks of September is almost never a league fixture; a game in October or later almost always is.
- Copy club names EXACTLY as the article writes them, including sponsor prefixes. Do not translate or normalise.
- Only output a date when the article gives one that resolves to a real day. If it says "mid-September" or gives no date, leave date empty and put the wording in dateText.
- Never guess a time, arena or broadcaster. Empty means the source did not say. A tip-off time is valuable — take it whenever it is printed, including from a fixture table column.
- Take the broadcaster whenever a channel or stream is named for a specific game, and its link if one is given.
- This tracks CLUBS only. A game involving a national team (Greece, Israel, Serbia...) is not a club game: set isNationalTeam=true so it can be filtered out.
- Games already played DO belong here. Set played=true with homeScore and awayScore, and include any boxscore or match-report link given for it. Do not invent a score: without one, played stays false.

Many of these pages are fixture TABLES rather than prose. Read every row, and use the column headers: a column naming the competition tells you which rows are league games and which are preseason.

In a fixture table EVERY row names two clubs, unless the source itself writes a placeholder for one of them.

- The source writes a real opponent: return both clubs.
- The source writes "TBA", "TBD", "to be confirmed", "winner of the semi-final": return the club you CAN see and set opponentUndecided=true. Do not throw the known club away.
- You cannot make the row out at all: return no clubs and leave opponentUndecided false. A half row with no explanation is worse than nothing.

A club whose name contains punctuation is still a club: "Igokea m:tel", "Zenit St.Petersburg" and "Vienna" are ordinary team names.

On a club's OWN site or social account the club often does not name itself — "we host Gipuzkoa on Tuesday", or a fixture table with only an opponent column. Return the opponent you can see; the club it belongs to is known from elsewhere.

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

/* ---------- sanity ---------- */
// Club sites keep archives, and a fixture table from a past season looks
// exactly like a current one to a reader dropped into the middle of it.
// Lietkabelis's page returned a full 2016 preseason, scores and all.
const SEASON_FROM = "2026-06-01";
const SEASON_TO = "2027-07-31";

function inSeason(g) {
  if (!g.date) return true; // an undated fixture cannot be judged this way
  if (!/^\d{4}-\d{2}-\d{2}$/.test(g.date)) return false;
  return g.date >= SEASON_FROM && g.date <= SEASON_TO;
}

/**
 * Fixture tables carry placeholder cells, and read out of context they look
 * like club names: "Por confirmar", "En caso de clasificación", a bare "VS".
 * A placeholder means the opponent is undecided, which the schema already has
 * a field for — it must not become a club in the registry.
 */
/**
 * Short tokens must match the WHOLE string. Without the anchor, "v" matched
 * the start of Vienna, Valencia, Virtus and Villeurbanne, and every one of
 * them was silently deleted from its own fixture — which is exactly how a
 * game ends up showing only one team. Longer phrases can still match a
 * prefix, since they only ever appear as placeholders.
 */
const PLACEHOLDER_EXACT = /^(vs?|v|-|—|–|tbd|tba|n\/a|\?|טרם|יריב)$/i;
const PLACEHOLDER_PREFIX =
  /^(por confirmar|en caso de clasificaci|a confirmar|da definire|belirlenecek|θα οριστεί|to be (confirmed|announced)|טרם נקבע|יריבה טרם|לקביעה)/i;
const PLACEHOLDER = {
  test: (s) => PLACEHOLDER_EXACT.test(String(s).trim()) || PLACEHOLDER_PREFIX.test(String(s).trim()),
};

const isRealTeam = (s) => {
  const v = String(s || "").trim();
  return v.length > 2 && !PLACEHOLDER.test(v);
};

const WOMENS = /(femenin|femminil|women|féminin|frauen|kadinlar|kadınlar|γυναικών|zenska|ženska|moteru|moterų|sieviesu|sieviešu|kobiet)|LF|WNBA/i;
const isWomens = (g, url) => WOMENS.test([g.tournament, g.homeTeam, g.awayTeam, ...(g.teams||[]), url].join(" "));

function hasTeams(g) {
  const names = [g.homeTeam, g.awayTeam, ...(g.teams || [])].filter(isRealTeam);
  return names.length > 0;
}

/**
 * A game in the future cannot have been played. JL Bourg's page returned
 * scores for fixtures dated 13 and 14 September while it was still August —
 * last season's results carried onto this season's dates. The fixture may
 * well be real, so the score is dropped rather than the row.
 */
function dropImpossibleResult(g, today) {
  if (!g.played) return false;
  // A game that has been played happened on a day. acb.com/es/supercopa
  // carries the competition's past finals, and "Real Madrid 94:98 Valencia"
  // arrived with no date at all — last season's final, which the window check
  // waved through precisely because it had no date to judge.
  if (!g.date || g.date > today) {
    g.played = false; g.homeScore = null; g.awayScore = null;
    return true;
  }
  return false;
}

/**
 * A broadcaster is a channel, not an account. A Budućnost tweet gave
 * "@RTCGme" as the broadcaster: a Twitter handle, no link, on a game with no
 * date. Shown on a card it is worse than showing nothing — it looks like
 * information and cannot be acted on.
 */
function cleanBroadcast(g) {
  const name = String(g.broadcaster || "").trim();
  if (!name) return;
  const bare = /^@\w+$/.test(name);
  if (bare && !g.broadcastUrl) { g.broadcaster = ""; return; }
  if (bare) g.broadcaster = name.replace(/^@/, "");
}

/** Drop placeholder names in place, flagging the opponent as undecided. */
function cleanTeams(g) {
  const drop = (v) => (isRealTeam(v) ? v : "");
  if (g.homeTeam && !isRealTeam(g.homeTeam)) { g.homeTeam = ""; g.opponentUndecided = true; }
  if (g.awayTeam && !isRealTeam(g.awayTeam)) { g.awayTeam = ""; g.opponentUndecided = true; }
  if (Array.isArray(g.teams)) {
    const kept = g.teams.filter(isRealTeam);
    if (kept.length < g.teams.length) g.opponentUndecided = true;
    g.teams = kept;
  }
  return drop;
}

/* ---------- run ---------- */
const cachePath = path.join(DATA, "extracted.json");
const cache = fs.existsSync(cachePath)
  ? JSON.parse(fs.readFileSync(cachePath, "utf8"))
  : { articles: {} };

const { candidates } = JSON.parse(fs.readFileSync(path.join(DATA, "candidates.json"), "utf8"));
/**
 * A news article is written once and never changes, so reading it twice is
 * waste. A club's fixture page is the opposite: it is the same URL all season
 * while tip-off times appear, opponents get drawn and results fill in. Caching
 * it forever means the page is frozen at whatever it said the first time.
 *
 * So living pages expire and articles do not.
 */
// League calendars change most of all: results land in them the same night.
/**
 * How often a source is worth reading again, by what it is.
 *
 * A tweet is as immutable as an article — it is written once and never
 * edited. Marking the whole social layer as living made 149 frozen tweets
 * eligible for re-reading on every run, which is 19 of the day's 80 model
 * requests spent re-reading text that had not changed. The twitter layer
 * still refetches every timeline each run to find NEW tweets; that part
 * costs no quota.
 *
 * League calendars are the opposite: one page, rewritten the same night a
 * game is played, and the only place most results ever appear. They get the
 * shortest interval by far.
 */
const TTL_HOURS = {
  "league:": Number(process.env.RECHECK_LEAGUE_HOURS || 2),
  "club:": Number(process.env.RECHECK_CLUB_HOURS || 10),
};

function ttlFor(outlet) {
  for (const [prefix, hours] of Object.entries(TTL_HOURS)) {
    if (String(outlet).startsWith(prefix)) return hours;
  }
  return null; // immutable: read once, ever
}

const LIVING = (outlet) => ttlFor(outlet) !== null;

function isStale(c) {
  const seen = cache.articles[c.url];
  if (!seen) return true;
  const ttl = ttlFor(c.outlet);
  if (ttl === null) return false;
  if (!seen.readAt) return true;
  return (Date.now() - Date.parse(seen.readAt)) / 36e5 >= ttl;
}

const unread = candidates.filter(isStale);
// Living pages first: a fixture page that has gained a tip-off time matters
// more than one more article about a transfer.
// Shortest interval first: a league calendar carrying tonight's result
// outranks a club page, which outranks an archive article.
unread.sort((a, b) =>
  (ttlFor(a.outlet) ?? 1e9) - (ttlFor(b.outlet) ?? 1e9) || (b.score - a.score));
const todo = unread.slice(0, MAX_ARTICLES);

console.log(
  `candidates ${candidates.length} · cached ${candidates.length - unread.length} · reading ${todo.length}` +
  (unread.length > todo.length ? ` · deferred ${unread.length - todo.length} (MAX_ARTICLES)` : "")
);

const TODAY = new Date().toISOString().slice(0, 10);
let games = 0, official = 0, national = 0, failed = 0, rejected = 0, impossible = 0, stopped = false;

// Fetch first, batch second: an article with no readable text must not take up
// a slot in a batch, and fetching is free.
const fetched = [];
for (const c of todo) {
  // A tweet arrives with its text attached: mirrors are unreliable to fetch
  // twice, and a tweet is short enough to carry through the pipeline.
  const text = c.inlineText || await articleText(c.url);
  if (!text || text.length < (c.inlineText ? 30 : 200)) {
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
    for (const g of mine) {
      if (g.time === "00:00" || g.time === "0:00") g.time = "";
      if (dropImpossibleResult(g, TODAY)) impossible++;
      cleanBroadcast(g);
      cleanTeams(g);
    }
    const found = mine.filter((g) =>
      !g.isOfficialLeagueGame && !g.isNationalTeam && inSeason(g) && hasTeams(g) && !isWomens(g, a.url));
    official += mine.filter((g) => g.isOfficialLeagueGame).length;
    rejected += mine.filter((g) => !g.isOfficialLeagueGame && !g.isNationalTeam && (!inSeason(g) || !hasTeams(g))).length;
    national += mine.filter((g) => !g.isOfficialLeagueGame && g.isNationalTeam).length;
    games += found.length;

    cache.articles[a.url] = {
      ok: true, title: a.title, outlet: a.outlet, published: a.published,
      readAt: new Date().toISOString(), model, games: found,
    };

    if (found.length) {
      console.log(`[${found.length}] ${a.outlet} · ${a.title.slice(0, 60)}`);
      for (const g of found.slice(0, 6)) {
        const who = g.homeTeam && g.awayTeam ? `${g.homeTeam} v ${g.awayTeam}` : (g.teams || []).join(" v ");
        const score = g.played && g.homeScore != null ? ` = ${g.homeScore}:${g.awayScore}` : "";
        const tv = g.broadcaster ? ` 📺${g.broadcaster}` : "";
        console.log(`      ${g.date || g.dateText || "?"} ${(g.time || "").padEnd(5)} ${who}${score}${tv}`);
      }
    }
  }
  await new Promise((r) => setTimeout(r, GAP_MS));
}

fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
console.log(`\nfixtures extracted    : ${games}`);
console.log(`league games skipped  : ${official}`);
console.log(`national teams skipped: ${national}`);
console.log(`out of season / no team: ${rejected}`);
console.log(`future results dropped : ${impossible}`);
console.log(`articles failed       : ${failed}`);
console.log(`models spent today    : ${[...spent].join(", ") || "none"}`);
if (stopped) console.log(`stopped early — quota exhausted; the rest are cached as unread and resume next run`);
