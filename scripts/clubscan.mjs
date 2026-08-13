/**
 * Layer 2 collector: the clubs' own fixture pages.
 *
 * News reports name a tournament's participants; the club prints the actual
 * draw. hapoelbc.com/games gives "12.09.26 19:00 · Maxima Roma · Cagliari"
 * where every article said only "Bayern / Villeurbanne / Roma", and it marks
 * which games are preseason and which are league.
 *
 * These pages are tables, not articles, so they are fed to the extractor whole
 * rather than filtered by headline. Discovery tries the paths clubs actually
 * use, in the languages they use them in.
 */
import fs from "node:fs";
import path from "node:path";
import { get, toText } from "../lib/fetch.mjs";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const read = (f, fb) =>
  fs.existsSync(path.join(DATA, f)) ? JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")) : fb;

const registry = read("registry.json", { clubs: {} });
const teams = new Map(read("teams.json", { teams: [] }).teams.map((t) => [t.id, t]));

const FIXTURE_PATHS = [
  "/games", "/games/", "/schedule", "/schedule/", "/fixtures", "/matches",
  "/calendario", "/calendrier", "/kalender", "/spielplan", "/rungtynes",
  "/programma", "/mac-programi", "/utakmice", "/raspored", "/season.asp",
  "/en/games", "/en/schedule", "/en/fixtures", "/en/calendar", "/calendar",
];

// A fixture page names months or carries dd.mm dates, and mentions preseason
// or a scoreline separator. Cheap enough to check before spending a model call.
const LOOKS_LIKE_FIXTURES =
  /(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4})|(\d{1,2}\s+(sep|set|eyl|σεπ|rugs|sept|septemb))/i;
const PRESEASON_HINT =
  /הכנה|pre-?season|pretemporada|amichev|hazırlık|φιλικ|priprem|pasiruoš|testspiel|préparation|friendly/i;

const clubs = Object.entries(registry.clubs)
  .filter(([, c]) => c.website)
  .map(([id, c]) => ({ id, ...c, name: teams.get(id)?.name_he || c.name_src || id }));

console.log(`clubs with a website: ${clubs.length}`);

const found = [];
const health = [];

for (const club of clubs) {
  let origin;
  try { origin = new URL(club.website).origin; } catch { continue; }

  // A page we already learned about is tried first and alone.
  const paths = club.fixturesUrl ? [club.fixturesUrl] : FIXTURE_PATHS.map((p) => origin + p);

  let hit = null;
  for (const url of paths) {
    const html = await get(url);
    if (!html) continue;
    const text = toText(html, 20000);
    if (text.length < 400 || !LOOKS_LIKE_FIXTURES.test(text)) continue;
    hit = { url, text, preseason: PRESEASON_HINT.test(text) };
    break;
  }

  if (!hit) { health.push({ club: club.name, ok: false }); continue; }

  // Remember where it was, so the next run costs one request instead of twenty.
  registry.clubs[club.id].fixturesUrl = hit.url;
  health.push({ club: club.name, ok: true, url: hit.url, preseason: hit.preseason });
  found.push({
    outlet: `club:${club.id}`,
    club: club.name,
    lang: "auto",
    strategy: "club-page",
    title: `לוח משחקים — ${club.name}`,
    url: hit.url,
    published: null,
    matchedKeywords: hit.preseason ? ["fixtures-page"] : [],
    matchedClubs: [club.name],
    // A page that says "preseason" outranks a bare fixture table.
    score: hit.preseason ? 9 : 6,
  });
}

fs.writeFileSync(path.join(DATA, "registry.json"), JSON.stringify(registry, null, 2));

// Merge into the candidate list the extractor reads, replacing this club's
// previous entry rather than piling duplicates up run after run.
const existing = read("candidates.json", { candidates: [], health: [] });
const kept = (existing.candidates || []).filter((c) => !String(c.outlet).startsWith("club:"));
fs.writeFileSync(path.join(DATA, "candidates.json"), JSON.stringify({
  generated: new Date().toISOString(),
  health: existing.health || [],
  clubHealth: health,
  candidates: [...kept, ...found].sort((a, b) => b.score - a.score),
}, null, 2));

const withPre = found.filter((f) => f.score === 9).length;
console.log(`fixture pages found : ${found.length}/${clubs.length}`);
console.log(`  of those, mentioning preseason: ${withPre}`);
console.log(`not found           : ${health.filter((h) => !h.ok).length}`);
for (const h of health.filter((h) => h.ok && h.preseason).slice(0, 12)) {
  console.log(`  · ${h.club} — ${h.url}`);
}
