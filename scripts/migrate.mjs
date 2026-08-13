/**
 * One-off migration: the hand-written preseason.html -> canonical data model.
 *
 * The old file stored one row PER TEAM PER GAME, so every game between two
 * covered teams appears twice. Here we collapse to one row per game and lift
 * `tier` off the game and onto the team (a team can be in several competitions).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SRC = process.argv[2] || "C:/Users/dubiy/Downloads/preseason.html";
const OUT = path.resolve(import.meta.dirname, "..", "data");

const COMPETITIONS = {
  1: "euroleague",
  2: "eurocup",
  3: "bcl",
  4: "aba",
  5: "domestic",
};

/* ---------- 1. pull the GAMES array out of the HTML ---------- */
const html = fs.readFileSync(SRC, "utf8");
const start = html.indexOf("const GAMES = [");
const end = html.indexOf("\n];", start);
if (start < 0 || end < 0) throw new Error("GAMES array not found");
const literal = html.slice(start + "const GAMES = ".length, end + 2);
const rows = eval(literal); // trusted local file

/* ---------- 2. name normalisation ---------- */
// Strips gershayim, quotes, sponsor prefixes and whitespace so that
// "הפועל ירושלים \"מידטאון\"" and "הפועל ירושלים" collapse to one key.
// Turkish and Spanish clubs are routinely written with the current shirt
// sponsor in front. Erokspor appears as both "Esenler Erokspor" and
// "Safiport Erokspor" across two seasons of reporting — same club.
const SPONSOR_PREFIXES = [
  "אסיסה", "סורנה", "מונבוס", "קסדמונט", "קוביראן", "MLP", "Glint",
  "Esenler", "Safiport", "Yukatel", "Kosner", "Bahçeşehir Koleji",
];
function normName(raw) {
  let s = String(raw || "").trim();
  // Only double quotes are gershayim-as-punctuation. A single geresh modifies a
  // Hebrew letter for foreign sounds (ז'לגיריס, קלוז', צ'אצ'אק) and must survive.
  s = s.replace(/["״]/g, " ");
  s = s.replace(/\([^)]*\)/g, " ");
  for (const p of SPONSOR_PREFIXES) {
    if (s.startsWith(p + " ")) s = s.slice(p.length + 1);
  }
  return s.replace(/\s+/g, " ").trim();
}
const slug = (s) =>
  "t_" + crypto.createHash("sha1").update(normName(s)).digest("hex").slice(0, 8);

// An "opponent" containing a slash is not a team, it is a list of candidates.
const isMultiCandidate = (s) => /\s\/\s/.test(String(s || ""));
const isUnknownOpponent = (s) =>
  /טרם|לא צוין|לא ידוע|לא סופי|יריבה/.test(String(s || ""));

/* ---------- 3. build the team registry ---------- */
const teams = new Map();
function touchTeam(rawName, tier, { canonical = false } = {}) {
  const name = normName(rawName);
  if (!name) return null;
  const id = slug(name);
  if (!teams.has(id)) {
    teams.set(id, {
      id,
      name_he: name,
      name_src: null,
      aliases: new Set(),
      competitions: new Set(),
      country: null,
      // Filled by the collectors. Lets a home game show its hall even when the
      // report only says the city.
      homeArena: null,
      website: null,
      newsUrl: null,
      // clubs we have never seen publish anything get polled hardest
      watchlist: false,
    });
  }
  const t = teams.get(id);
  if (rawName !== name) t.aliases.add(String(rawName).trim());
  // only the row's own `team` field is authoritative for competition membership;
  // an opponent may well be a club from outside our tracked competitions.
  if (canonical && tier && COMPETITIONS[tier]) t.competitions.add(COMPETITIONS[tier]);
  return t;
}

for (const r of rows) {
  touchTeam(r.team, r.tier, { canonical: true });
  if (!isMultiCandidate(r.opponent) && !isUnknownOpponent(r.opponent)) {
    touchTeam(r.opponent, r.tier);
  }
}

/* ---------- 4. collapse rows into games ---------- */
// Identity of a game = date + the unordered pair of clubs. Rows with no date or
// no resolvable opponent cannot be deduped, so they keep their own identity.
function gameKey(r) {
  const a = normName(r.team);
  const b = normName(r.opponent);
  if (!r.date || isMultiCandidate(r.opponent) || isUnknownOpponent(r.opponent)) {
    return "solo:" + [a, r.date || "", r.dateLabel || "", b].join("|");
  }
  return "pair:" + r.date + "|" + [a, b].sort().join("|");
}

/**
 * The old `type` field mixed three things: the competition, the stage within it,
 * and circumstantial notes. "טורניר קרתי (חצי גמר)" and "טורניר קרתי (גמר)"
 * counted as two different tournaments, and 60 of 131 games were tagged
 * "משחק הכנה" — which is not a competition, it is the absence of one.
 */
const STAGE_WORDS = /^(חצי גמר|גמר|רבע גמר|שלב גמר|שלב הבתים)$/;
// Who hosts is not shown anywhere, so it is dropped rather than kept as a flag.
const DROP_WORDS = /^(מארחת|מארח)$/;
function splitType(raw) {
  let s = String(raw || "").trim();
  if (!s || s === "-") return { tournament: null, stage: null, flags: [] };

  const flags = [];
  let stage = null;
  s = s.replace(/\(([^)]*)\)/g, (_, inner) => {
    const v = inner.trim();
    if (DROP_WORDS.test(v)) { /* discard */ }
    else if (STAGE_WORDS.test(v)) stage = v;
    else flags.push(v);
    return " ";
  }).replace(/\s+/g, " ").trim();

  // A plain friendly carries no competition name.
  if (/^משחק(י)? הכנה$/.test(s) || /^משחק ידידות$/.test(s)) s = "";
  return { tournament: s || null, stage, flags };
}

const COUNTRIES = [
  "ישראל", "ספרד", "איטליה", "טורקיה", "יוון", "גרמניה", "צרפת", "ליטא",
  "לטביה", "סרביה", "קרואטיה", "סלובניה", "בולגריה", "רומניה", "פולין",
  "אנגליה", "מונטנגרו", "בוסניה", "צ'כיה", "סלובקיה", "אוסטריה", "בלגיה",
  "פורטוגל", "אזרבייג'ן", "רוסיה", "ארה\"ב",
];

/**
 * Venue arrives as free text in a few shapes:
 *   "עיר, מדינה"  ·  "עיר (אולם), מדינה"  ·  "עיר, מדינה (אולם)"  ·  "מדינה"
 * Split so the card can lead with the hall. Only 6 of 130 seed rows name one;
 * the rest fill in from the club's home arena once home/away is known, which is
 * why homeTeam stays in the data even though the card no longer shows it.
 */
function splitVenue(raw) {
  let s = String(raw || "").trim();
  if (!s || s === "-") return { arena: null, city: null, country: null };

  let arena = null;
  s = s.replace(/\(([^)]*)\)/g, (_, inner) => { arena = inner.trim(); return " "; });
  s = s.replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").replace(/(^,|,$)/g, "").trim();

  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  let country = null, city = null;
  if (parts.length && COUNTRIES.includes(parts[parts.length - 1])) {
    country = parts.pop();
  }
  city = parts.join(", ") || null;
  // A lone country string parses as a city; move it across.
  if (!country && city && COUNTRIES.includes(city)) { country = city; city = null; }
  return { arena, city, country };
}

function parseTime(dateLabel) {
  const m = String(dateLabel || "").match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

const games = new Map();
for (const r of rows) {
  const key = gameKey(r);
  const home = r.homeAway === "בית" ? r.team : r.homeAway === "חוץ" ? r.opponent : null;
  const away = r.homeAway === "בית" ? r.opponent : r.homeAway === "חוץ" ? r.team : null;

  const record = {
    id: "g_" + crypto.createHash("sha1").update(key).digest("hex").slice(0, 10),
    date: r.date || null,
    dateLabel: r.dateLabel || null,
    time: parseTime(r.dateLabel),
    // teams[] is unordered when the venue is neutral; home/away set only when known
    teams: [slug(r.team)].concat(
      isMultiCandidate(r.opponent) || isUnknownOpponent(r.opponent) ? [] : [slug(r.opponent)]
    ),
    homeTeam: home ? slug(home) : null,
    awayTeam: away ? slug(away) : null,
    candidates: isMultiCandidate(r.opponent)
      ? r.opponent.split(/\s\/\s/).map((s) => s.trim())
      : [],
    opponentTbd: isUnknownOpponent(r.opponent),
    venue: splitVenue(r.location),
    ...splitType(r.type),
    broadcast: [],
    confidence: 1,
    sources: [],
    notes: [],
  };

  if (!games.has(key)) {
    games.set(key, record);
  } else {
    // Second sighting of the same game: fill gaps. Confidence is NOT bumped here
    // -- the same club can be listed under two competitions, which would double
    // count a single source. It is derived from distinct sources at the end.
    const g = games.get(key);
    g.time ||= record.time;
    for (const k of ["arena", "city", "country"]) g.venue[k] ||= record.venue[k];
    g.tournament ||= record.tournament;
    g.stage ||= record.stage;
    for (const f of record.flags) if (!g.flags.includes(f)) g.flags.push(f);
    g.homeTeam ||= record.homeTeam;
    g.awayTeam ||= record.awayTeam;
    for (const id of record.teams) if (!g.teams.includes(id)) g.teams.push(id);
  }

  const g = games.get(key);
  if (r.source && r.source !== "-" && !g.sources.some((s) => s.url === r.sourceUrl)) {
    g.sources.push({ name: r.source, url: r.sourceUrl || null });
  }
  if (r.note && !g.notes.includes(r.note)) g.notes.push(r.note);
}

/* ---------- 5. fold in hand-entered games ---------- */
const manualPath = path.join(OUT, "manual.json");
let manualCount = 0;
if (fs.existsSync(manualPath)) {
  const manual = JSON.parse(fs.readFileSync(manualPath, "utf8"));
  for (const m of manual.games || []) {
    touchTeam(m.team, null, { canonical: true });
    if (m.opponent) touchTeam(m.opponent, null);
    for (const c of m.candidates || []) touchTeam(c, null);

    const key = "manual:" +
      [normName(m.team), normName(m.opponent || ""), m.date || "", m.time || "", m.tournament || ""].join("|");
    games.set(key, {
      id: "g_" + crypto.createHash("sha1").update(key).digest("hex").slice(0, 10),
      date: m.date || null,
      dateLabel: m.dateLabel || null,
      time: m.time || null,
      teams: [slug(m.team)].concat(m.opponent ? [slug(m.opponent)] : []),
      homeTeam: m.homeTeam ? slug(m.homeTeam) : null,
      awayTeam: m.awayTeam ? slug(m.awayTeam) : null,
      candidates: m.candidates || [],
      opponentTbd: !(m.candidates || []).length && !m.opponent,
      venue: m.venue || { arena: null, city: null, country: null },
      tournament: m.tournament || null,
      stage: m.stage || null,
      flags: m.flags || [],
      broadcast: m.broadcast || [],
      confidence: 0,
      sources: m.sources || [],
      notes: m.notes || [],
      manual: true,
    });
    manualCount++;
  }
}

/* ---------- 6. emit ---------- */
const teamList = [...teams.values()]
  .map((t) => ({
    ...t,
    aliases: [...t.aliases],
    competitions: [...t.competitions],
  }))
  .sort((a, b) => a.name_he.localeCompare(b.name_he, "he"));

// Confidence = how many independent outlets reported this game.
for (const g of games.values()) {
  g.confidence = new Set(g.sources.map((s) => s.url || s.name)).size;
}

const gameList = [...games.values()].sort((a, b) =>
  (a.date || "9999").localeCompare(b.date || "9999")
);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(
  path.join(OUT, "teams.json"),
  JSON.stringify({ updated: null, teams: teamList }, null, 2)
);
fs.writeFileSync(
  path.join(OUT, "games.json"),
  JSON.stringify({ updated: null, season: "2026-27", games: gameList }, null, 2)
);

/* ---------- report ---------- */
const dupes = rows.length + manualCount - gameList.length;
const multi = teamList.filter((t) => t.competitions.length > 1);
console.log(`rows in old file : ${rows.length}`);
console.log(`real games       : ${gameList.length}   (${dupes} duplicates collapsed)`);
console.log(`confirmed by 2+  : ${gameList.filter((g) => g.confidence > 1).length}`);
console.log(`teams registered : ${teamList.length}`);
console.log(`multi-competition: ${multi.length}  ->  ${multi.map((t) => t.name_he).join(", ")}`);
console.log(`no date yet      : ${gameList.filter((g) => !g.date).length}`);
console.log(`opponent unknown : ${gameList.filter((g) => g.opponentTbd).length}`);
console.log(`with a time      : ${gameList.filter((g) => g.time).length}`);
console.log(`with an arena    : ${gameList.filter((g) => g.venue.arena).length}`);
console.log(`with a city      : ${gameList.filter((g) => g.venue.city).length}`);
console.log(`hand-entered   : ${manualCount}`);
console.log(`real tournaments : ${new Set(gameList.map((g) => g.tournament).filter(Boolean)).size}`);
