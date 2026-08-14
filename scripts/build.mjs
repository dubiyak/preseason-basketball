/**
 * Compose games.json and teams.json from every source, deterministically.
 *
 *   seed.json      frozen one-time migration of the original hand-written page
 *   manual.json    hand-entered games and corrections; always win
 *   extracted.json whatever the collector read since
 *   registry.json  durable per-club facts (Hebrew name, site, home arena)
 *
 * Rebuilt from scratch every run, so the output depends only on the inputs and
 * never on the order runs happened in.
 */
import fs from "node:fs";
import path from "node:path";
import { normName, splitVenue, gameKey, gameId } from "../lib/normalize.mjs";
import {
  loadAliases, saveAliases, buildIndex, resolveLocal, resolveWithModel, newClub,
} from "./resolve.mjs";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const read = (f, fallback) =>
  fs.existsSync(path.join(DATA, f)) ? JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")) : fallback;

const seed = read("seed.json", { games: [], teams: [] });
const manual = read("manual.json", { games: [] });
const extracted = read("extracted.json", { articles: {} });
const registry = read("registry.json", { clubs: {} });
const aliases = loadAliases();

function loadKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const f = path.resolve(import.meta.dirname, "..", ".env");
  if (!fs.existsSync(f)) return null;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && line.slice(0, i).trim() === "GEMINI_API_KEY") return line.slice(i + 1).trim();
  }
  return null;
}
const MODELS = (process.env.GEMINI_MODELS ||
  "gemini-flash-latest,gemini-flash-lite-latest,gemini-3-flash-preview,gemini-3.1-flash-lite-preview")
  .split(",").map((s) => s.trim());

/* ---------- 1. clubs ---------- */
const clubs = new Map(seed.teams.map((t) => [t.id, { ...t, aliases: [...(t.aliases || [])] }]));
let index = buildIndex([...clubs.values()]);

/**
 * Clubs tag each other by handle, so a tweet says "@valenciabasket" where an
 * article says "Valencia Basket". The registry already holds the handle for 46
 * clubs, which makes this an exact lookup rather than another guess.
 */
const byHandle = new Map();
for (const [id, c] of Object.entries(registry.clubs)) {
  if (!c.twitter) continue;
  const h = String(c.twitter).replace(/^.*\//, "").replace(/^@/, "").toLowerCase();
  if (h) byHandle.set(h, id);
}
const handleId = (name) => {
  const m = String(name || "").trim().match(/^@(\w+)$/);
  return m ? byHandle.get(m[1].toLowerCase()) : undefined;
};

function ensureClub(name) {
  const viaHandle = handleId(name);
  if (viaHandle) { aliases.map[String(name).trim()] = viaHandle; return viaHandle; }
  const id = resolveLocal(name, index, aliases);
  if (id && clubs.has(id)) {
    const c = clubs.get(id);
    const raw = String(name).trim();
    if (raw && raw !== c.name_he && !c.aliases.includes(raw)) c.aliases.push(raw);
    return id;
  }
  return null;
}

/* ---------- 2. gather every game from every source ---------- */
// A record is source-shaped; resolution to ids happens after all names are known.
const records = [];

for (const g of seed.games) {
  records.push({ origin: "seed", g });
}
for (const m of manual.games) {
  records.push({ origin: "manual", g: m });
}
for (const [url, a] of Object.entries(extracted.articles)) {
  if (!a.ok || !a.games?.length) continue;
  for (const g of a.games) {
    records.push({
      origin: "extracted",
      article: { url, outlet: a.outlet, title: a.title, published: a.published, readAt: a.readAt },
      g,
    });
  }
}

/* ---------- 3. resolve every club name that appears ---------- */
const wanted = new Set();
const nameOf = (r) => {
  const g = r.g;
  if (r.origin === "extracted") {
    return [g.homeTeam, g.awayTeam, ...(g.teams || [])].filter(Boolean);
  }
  return [
    ...(g.teams || []).map((id) => clubs.get(id)?.name_he).filter(Boolean),
    g.team, g.opponent, ...(g.candidates || []),
  ].filter(Boolean);
};
/**
 * Some "opponents" in the seed are descriptions, not clubs: "קבוצות בטורניר
 * קליארי" (the teams in the Cagliari tournament), "יריבה בסלובניה". They were
 * registered as clubs and then appeared on cards as if a team by that name
 * existed.
 */
const PSEUDO_CLUB = /^(קבוצות|יריבה|יריבות|קבוצה|טרם|לא )|בטורניר|טרם נקבע|טרם ידוע|טרם פורסם/;
const isPseudo = (n) => PSEUDO_CLUB.test(String(n || "").trim());

for (const r of records) {
  for (const n of nameOf(r)) {
    if (isPseudo(n)) continue;
    if (!ensureClub(n)) wanted.add(String(n).trim());
  }
}

const unresolved = [...wanted];
let resolverModel = null;
if (unresolved.length) {
  const key = loadKey();
  if (!key) {
    console.log(`${unresolved.length} club names unresolved and no key — they stay as free text this run`);
  } else {
    const { data, model } = await resolveWithModel(unresolved, [...clubs.values()],
      { key, models: MODELS, log: (m) => console.log(m) });
    resolverModel = model || null;
    for (const r of data?.resolved || []) {
      // An unconfident answer is not recorded. A wrong merge is permanent;
      // an unresolved name is merely incomplete and retried next run.
      if (!r.confident) { console.log(`  ? unsure: ${r.name}`); continue; }
      if (r.matchesExisting && clubs.has(r.matchesExisting)) {
        aliases.map[r.name] = r.matchesExisting;
        const c = clubs.get(r.matchesExisting);
        if (!c.aliases.includes(r.name)) c.aliases.push(r.name);
      } else {
        // A "Hebrew name" with no Hebrew letters is a failed answer, not a new
        // club. Registering it would split one club across two scripts
        // permanently, so leave the name unresolved and retry next run.
        if (!/[֐-׿]/.test(r.hebrewName || "")) {
          console.log(`  ? no Hebrew name returned: ${r.name}`);
          continue;
        }
        // The id derives from the Hebrew name, so two inputs the model judged
        // to be one club collapse here without any extra matching.
        const c = newClub(r.name, r.hebrewName, r.country);
        if (!clubs.has(c.id)) clubs.set(c.id, c);
        else if (!clubs.get(c.id).aliases.includes(r.name)) clubs.get(c.id).aliases.push(r.name);
        aliases.map[r.name] = c.id;
      }
    }
    saveAliases(aliases);
    index = buildIndex([...clubs.values()]);
  }
}

/* ---------- 4. fold records into games ---------- */
const games = new Map();
const conflicts = [];
// Learned across runs: a foreign-language tournament name -> the canonical one.
const tournamentAliases = read("tournaments.json", { map: {} }).map;

const asVenue = (g, origin) => {
  if (origin === "extracted") {
    return { arena: g.arena || null, city: g.city || null, country: g.country || null };
  }
  return g.venue && typeof g.venue === "object" ? g.venue : splitVenue(g.venue);
};

function toRecord(r) {
  const { g, origin } = r;
  const names = nameOf(r).filter((n) => !isPseudo(n));
  const pseudo = nameOf(r).some(isPseudo);
  const ids = [...new Set(names.map((n) => resolveLocal(n, index, aliases)).filter(Boolean))];

  const home = origin === "extracted" ? g.homeTeam : (g.homeTeam ? clubs.get(g.homeTeam)?.name_he : null);
  const away = origin === "extracted" ? g.awayTeam : (g.awayTeam ? clubs.get(g.awayTeam)?.name_he : null);

  const sources = origin === "extracted"
    ? [{ name: r.article.outlet, url: r.article.url, published: r.article.published || null }]
    : (g.sources || []);

  return {
    date: g.date || null,
    dateLabel: g.dateLabel || g.dateText || null,
    time: g.time || null,
    teamIds: ids,
    homeTeam: home ? resolveLocal(home, index, aliases) : null,
    awayTeam: away ? resolveLocal(away, index, aliases) : null,
    // Names we could not resolve stay visible as text rather than vanishing.
    candidates: origin === "extracted"
      ? (g.opponentUndecided ? [] : names.filter((n) => !resolveLocal(n, index, aliases)))
      : (g.candidates || []),
    opponentTbd: (origin === "extracted" ? !!g.opponentUndecided : !!g.opponentTbd) || pseudo,
    venue: asVenue(g, origin),
    tournament: g.tournament || null,
    stage: g.stage || null,
    flags: [...(g.flags || []), ...(g.closedDoors ? ["דלתיים סגורות"] : [])],
    broadcast: g.broadcast || (g.broadcaster ? [{ name: g.broadcaster, url: g.broadcastUrl || null }] : []),
    // A played game keeps its score against the home/away order it was
    // reported in, so a later report from the other club cannot silently
    // reverse it.
    result: g.played && g.homeScore != null && g.awayScore != null
      ? { home: g.homeScore, away: g.awayScore }
      : (g.result || null),
    statsUrl: g.statsUrl || null,
    reportUrl: g.reportUrl || null,
    sources,
    notes: g.notes || [],
    origin,
    published: origin === "extracted" ? r.article.published : null,
  };
}

// Manual last: it overwrites, and overwriting requires arriving after.
const ordered = [
  ...records.filter((r) => r.origin === "seed"),
  ...records.filter((r) => r.origin === "extracted"),
  ...records.filter((r) => r.origin === "manual"),
];

for (const r of ordered) {
  const rec = toRecord(r);
  if (rec.tournament && tournamentAliases[rec.tournament]) rec.tournament = tournamentAliases[rec.tournament];
  const key = gameKey({
    date: rec.date, time: rec.time, teamIds: rec.teamIds,
    label: rec.dateLabel, tournament: rec.tournament,
  });

  if (!games.has(key)) {
    games.set(key, { ...rec, id: gameId(key), origins: [rec.origin] });
    continue;
  }

  const g = games.get(key);
  const manualWins = rec.origin === "manual";

  // Two names for the same fixture's tournament are two names for one
  // tournament — the shared game identity is the proof. Record the alias
  // instead of reporting a conflict, so the tournament view stops splitting
  // "Pavlos Janakopulos" from "טורניר פאבלוס יאנאקופולוס".
  if (g.tournament && rec.tournament && g.tournament !== rec.tournament) {
    tournamentAliases[rec.tournament] = g.tournament;
  }

  // Real disagreement is recorded, not silently resolved by arrival order.
  for (const field of ["time", "date"]) {
    if (g[field] && rec[field] && g[field] !== rec[field]) {
      conflicts.push({ game: g.id, field, have: g[field], alsoReported: rec[field],
                       from: rec.sources[0]?.name || rec.origin });
    }
  }

  if (manualWins) {
    Object.assign(g, {
      date: rec.date ?? g.date, time: rec.time ?? g.time,
      tournament: rec.tournament ?? g.tournament, venue: rec.venue,
    });
  } else {
    g.time ||= rec.time;
    g.tournament ||= rec.tournament;
    g.stage ||= rec.stage;
    g.result ||= rec.result;
    g.statsUrl ||= rec.statsUrl;
    g.reportUrl ||= rec.reportUrl;
    g.homeTeam ||= rec.homeTeam;
    g.awayTeam ||= rec.awayTeam;
    for (const k of ["arena", "city", "country"]) g.venue[k] ||= rec.venue[k];
  }

  for (const id of rec.teamIds) if (!g.teamIds.includes(id)) g.teamIds.push(id);
  for (const f of rec.flags) if (!g.flags.includes(f)) g.flags.push(f);
  for (const n of rec.notes) if (!g.notes.includes(n)) g.notes.push(n);
  for (const b of rec.broadcast) if (!g.broadcast.some((x) => x.name === b.name)) g.broadcast.push(b);
  for (const s of rec.sources) if (!g.sources.some((x) => (x.url || x.name) === (s.url || s.name))) g.sources.push(s);
  if (!g.origins.includes(rec.origin)) g.origins.push(rec.origin);
}

/**
 * A resolved fixture supersedes the guess it replaces.
 *
 * News reports name a tournament's field before the draw: "Hapoel v Bayern /
 * Villeurbanne / Roma on 12.9". The club then prints the actual pairing —
 * "Maxima Roma, 19:00". Those are different keys, so both survive the merge
 * and the page shows the guess next to the answer.
 *
 * Where a same-date, same-tournament entry names exactly two clubs and an
 * older vague entry lists one of them against a slate of candidates, the
 * vague one is retired. Its sources move across so nothing is lost.
 */
const vague = (g) => (g.candidates?.length || 0) > 0 || g.teamIds.length > 2;
const precise = [...games.values()].filter((g) => g.date && g.teamIds.length === 2 && !vague(g));

for (const [key, g] of games) {
  if (!vague(g) || !g.date) continue;
  // Matched on date and a shared club, not on tournament name: the club's own
  // page often labels the game only "preseason" while the news report names
  // the tournament. A club does not play twice on one day, so this is safe —
  // and the tournament name travels to the surviving entry.
  const answer = precise.find((p) =>
    p.date === g.date && p.teamIds.some((id) => g.teamIds.includes(id))
  );
  if (!answer) continue;
  answer.tournament ||= g.tournament;
  answer.stage ||= g.stage;
  for (const k of ["arena", "city", "country"]) answer.venue[k] ||= g.venue[k];
  for (const s of g.sources) {
    if (!answer.sources.some((x) => (x.url || x.name) === (s.url || s.name))) answer.sources.push(s);
  }
  for (const n of g.notes) if (!answer.notes.includes(n)) answer.notes.push(n);
  games.delete(key);
}

/* ---------- 5. emit ---------- */
const gameList = [...games.values()].map((g) => {
  const { teamIds, ...rest } = g;
  return {
    ...rest,
    teams: teamIds,
    // Independent outlets, not sightings: one club listed in two competitions
    // used to look like two confirmations of a single report.
    confidence: new Set(g.sources.map((s) => s.url || s.name)).size,
  };
}).sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));

const playing = new Set(gameList.flatMap((g) => g.teams));
const teamList = [...clubs.values()].map((t) => {
  const saved = registry.clubs[t.id] || {};
  return {
    ...t,
    name_he: saved.name_he || t.name_he,
    country: saved.country ?? t.country,
    homeArena: saved.homeArena ?? t.homeArena,
    website: saved.website ?? t.website,
    newsUrl: saved.newsUrl ?? t.newsUrl,
    aliases: [...new Set([...(t.aliases || []), ...(saved.aliases || [])])],
    // No fixtures anywhere means this club is the one worth polling hardest.
    watchlist: !playing.has(t.id),
  };
}).sort((a, b) => a.name_he.localeCompare(b.name_he, "he"));

const now = new Date().toISOString();
const prev = read("games.json", { games: [] });
const prevIds = new Set(prev.games.map((g) => g.id));
const added = gameList.filter((g) => !prevIds.has(g.id));

fs.writeFileSync(path.join(DATA, "games.json"), JSON.stringify({
  updated: now, season: "2026-27", newGames: added.length,
  conflicts, games: gameList,
}, null, 2));
fs.writeFileSync(path.join(DATA, "tournaments.json"), JSON.stringify({ _doc: "Tournament name as written -> canonical name. Learned when two reports of the same fixture name its tournament differently.", map: tournamentAliases }, null, 2));
fs.writeFileSync(path.join(DATA, "teams.json"), JSON.stringify({ updated: now, teams: teamList }, null, 2));

/* ---------- report ---------- */
const by = (o) => gameList.filter((g) => g.origins.includes(o)).length;
console.log(`games        : ${gameList.length}   (seed ${by("seed")} · extracted ${by("extracted")} · manual ${by("manual")})`);
console.log(`new this run : ${added.length}`);
console.log(`multi-source : ${gameList.filter((g) => g.confidence > 1).length}`);
console.log(`clubs        : ${teamList.length}   (watchlist ${teamList.filter((t) => t.watchlist).length})`);
console.log(`unresolved   : ${unresolved.length}${resolverModel ? ` · resolved via ${resolverModel}` : ""}`);
console.log(`conflicts    : ${conflicts.length}`);
for (const c of conflicts.slice(0, 6)) console.log(`  ~ ${c.field}: "${c.have}" vs "${c.alsoReported}" (${c.from})`);
for (const g of added.slice(0, 12)) {
  const who = g.teams.map((id) => clubs.get(id)?.name_he || "?").join(" מול ");
  console.log(`  + ${g.date || g.dateLabel || "?"} ${who}${g.tournament ? ` · ${g.tournament}` : ""}`);
}
