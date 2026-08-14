/**
 * Integrity checks over the published data.
 *
 * Every rule here exists because the thing it checks actually happened. Run
 * against the live site by default, or a local build with --local.
 */
import fs from "node:fs";
import path from "node:path";

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

  // A club archive returned a complete 2016 preseason, scores and all.
  ["nothing outside the season window",
    G.filter((g) => g.date && (g.date < "2026-06-01" || g.date > "2027-07-31")).length, 0],

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
