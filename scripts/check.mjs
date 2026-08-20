/**
 * Integrity checks over the published data.
 *
 * Every rule here exists because the thing it checks actually happened. Run
 * against the live site by default, or a local build with --local.
 */
import fs from "node:fs";
import path from "node:path";
import { freshness, MINUTE, SLOTS_UTC } from "../lib/schedule.mjs";
import { PRESEASON_FROM, PRESEASON_TO } from "../lib/dates.mjs";

const LOCAL = process.argv.includes("--local");
const BASE = "https://dubiyak.github.io/preseason-basketball/data";
const DATA = path.resolve(import.meta.dirname, "..", "data");

async function load(name) {
  if (LOCAL) return JSON.parse(fs.readFileSync(path.join(DATA, name), "utf8"));
  const res = await fetch(`${BASE}/${name}?cb=${Math.random().toString(36).slice(2)}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json();
}

const games = await load("games.json");
const teams = await load("teams.json");
const ids = new Set(teams.teams.map((t) => t.id));
const G = games.games;
const today = new Date().toISOString().slice(0, 10);

const checks = [
  // A club referenced by a game must have a record, or the card shows a dash.
  ["every team id resolves to a name",
    G.filter((g) => g.teams.some((i) => !ids.has(i))).length, 0],

  // A game that has been played happened on a day. acb.com's page of past
  // finals arrived undated with a score.
  ["no result without a date",
    G.filter((g) => g.result && !g.date).length, 0],

  // Last season's results carried onto this season's dates on a club page.
  ["no result dated in the future",
    G.filter((g) => g.result && g.date && g.date > today).length, 0],

  // A club archive returned a complete 2016 preseason, scores and all — and at
  // the other end, two NBA games staged in Europe in January 2027 sat in the
  // list looking like ordinary friendlies. The preseason ends when the
  // competitions start. The window is defined once, in lib/dates.mjs.
  ["nothing outside the preseason window",
    G.filter((g) => g.date && (g.date < PRESEASON_FROM || g.date > PRESEASON_TO)).length, 0],

  // Liga Femenina fixtures are published on the same sites as the men's.
  ["no women's competitions",
    G.filter((g) => /femenin|femminil|\bLF\b|women/i.test(g.tournament || "")).length, 0],

  // A Twitter handle is not a broadcaster, and unusable on a card.
  ["no broadcaster given as a bare handle",
    G.filter((g) => (g.broadcast || []).some((b) => /^@?\w+$/.test(b.name) && !b.url && b.name.startsWith("@"))).length, 0],

  // Two ids for one club is how "Vienna" and "Valencia" vanished.
  ["no duplicate club names",
    teams.teams.length - new Set(teams.teams.map((t) => t.name_he)).size, 0],

  // An entry with neither a club nor a date carries nothing at all.
  ["no entry with neither team nor date",
    G.filter((g) => !g.teams.length && !g.candidates.length && !g.date).length, 0],

  // "משחקי הכנה" means "preseason games". Learned as a tournament name, it
  // put the Neofytos Chandriotis Tournament on four unrelated friendlies.
  ["no generic label used as a tournament name",
    G.filter((g) => /^(משחק(י)? הכנה|משחק ידידות|amichevol|friendly|pre-?season|pretemporada|precampionato|vorbereitung|testspiel|hazırlık|φιλικ|priprem|amical)\w*\s*\d*$/i
      .test((g.tournament || "").trim())).length, 0],

  // A tournament runs on consecutive days. A name spread across a month is a
  // name that leaked onto games that do not belong to it.
  ["no tournament spanning more than 16 days", (() => {
    const span = new Map();
    for (const g of G) {
      if (!g.tournament || !g.date) continue;
      const s = span.get(g.tournament) || [g.date, g.date];
      span.set(g.tournament, [g.date < s[0] ? g.date : s[0], g.date > s[1] ? g.date : s[1]]);
    }
    return [...span.values()]
      .filter(([a, b]) => (Date.parse(b) - Date.parse(a)) / 864e5 > 16).length;
  })(), 0],

  // Aliases that chain drift a little further from themselves every run.
  ["no chained tournament aliases", await (async () => {
    let map = {};
    try { map = (await load("tournaments.json")).map || {}; } catch { return 0; }
    return Object.values(map).filter((v) => map[v]).length;
  })(), 0],

  // The site is published on a schedule that is deliberately uneven: six runs
  // clustered around the evening, with a nine-hour daylight gap by design. A
  // flat hour count cannot tell that gap apart from a stall, so this asks the
  // schedule itself whether a run has come due and gone unanswered.
  ["published by the last run that came due",
    freshness(games.updated).stale ? 1 : 0, 0],

  // A game that has been played and whose source publishes results should
  // have one. Two past games sat without a score for five days because the
  // ABA calendar had been dropped from the candidate list and never re-read.
  ["no game played over 48h ago still missing a result", (() => {
    const cutoff = new Date(Date.now() - 48 * 36e5).toISOString().slice(0, 10);
    return G.filter((g) => g.date && g.date < cutoff && !g.result &&
      g.sources.some((x) => /league:/.test(x.name || ""))).length;
  })(), 0],

  // The freshness rule above reads the schedule from lib/schedule.mjs, but the
  // runs are actually driven by the cron list in the workflow. Let the two
  // drift and the alarm goes quietly wrong in whichever direction hurts more:
  // silent through a real stall, or shouting through a gap that is by design.
  ["the cron list matches lib/schedule.mjs", (() => {
    const yml = fs.readFileSync(
      path.resolve(import.meta.dirname, "..", ".github", "workflows", "update.yml"), "utf8");
    const crons = [...yml.matchAll(/- cron: "(\d+) (\d+) \* \* \*"/g)];
    const minutes = new Set(crons.map((m) => Number(m[1])));
    const hours = crons.map((m) => Number(m[2])).sort((a, b) => a - b);
    const sameMinute = minutes.size === 1 && minutes.has(MINUTE);
    const sameHours = JSON.stringify(hours) === JSON.stringify([...SLOTS_UTC].sort((a, b) => a - b));
    return sameMinute && sameHours ? 0 : 1;
  })(), 0],
];

let failed = 0;
for (const [name, actual, expected] of checks) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (${actual}, expected ${expected})`}`);
}

console.log("");
console.log(`games        : ${G.length}`);
console.log(`clubs        : ${teams.teams.length}`);
console.log(`with a time  : ${G.filter((g) => g.time).length}`);
console.log(`with an arena: ${G.filter((g) => g.venue?.arena).length}`);
console.log(`with a result: ${G.filter((g) => g.result).length}`);
console.log(`corroborated : ${G.filter((g) => g.confidence > 1).length}`);
console.log(`undated      : ${G.filter((g) => !g.date).length}`);
console.log(`one club only: ${G.filter((g) => g.teams.length === 1 && !g.candidates.length).length}`);
console.log(`conflicts    : ${(games.conflicts || []).length}`);
console.log(`updated      : ${games.updated}`);

process.exit(failed ? 1 : 0);
