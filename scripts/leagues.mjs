/**
 * Layer 0: the leagues' own preseason calendars.
 *
 * The best source there is. aba-liga.com/calendar-preseason lists every
 * preseason game in the Adriatic league — both clubs, date, time, and the
 * result once played — in one authoritative table that no club site or news
 * report can match for completeness.
 *
 * Most leagues have not published theirs yet. So this does not hold a fixed
 * list of URLs: each run it probes every league site for a page like this,
 * and adopts it the day it appears. A page found once is remembered, and
 * because these tables change constantly they are re-read every run.
 */
import fs from "node:fs";
import path from "node:path";
import { get, toText } from "../lib/fetch.mjs";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const read = (f, fb) =>
  fs.existsSync(path.join(DATA, f)) ? JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")) : fb;

// Every competition worth a calendar page, whether or not it has one yet.
const LEAGUES = [
  { id: "aba", name: "אדריאטית (ABA)", site: "https://www.aba-liga.com",
    known: "https://www.aba-liga.com/calendar-preseason/26/1/" },
  { id: "euroleague", name: "יורוליג", site: "https://www.euroleaguebasketball.net/en/euroleague" },
  { id: "eurocup", name: "יורוקאפ", site: "https://www.euroleaguebasketball.net/en/eurocup" },
  { id: "bcl", name: "BCL", site: "https://www.championsleague.basketball" },
  { id: "acb", name: "ליגה ספרדית (ACB)", site: "https://www.acb.com" },
  { id: "lba", name: "ליגה איטלקית (LBA)", site: "https://www.legabasket.it" },
  { id: "lnb", name: "ליגה צרפתית (LNB)", site: "https://www.lnb.fr" },
  { id: "bbl", name: "ליגה גרמנית (BBL)", site: "https://www.easycredit-bbl.de" },
  { id: "israel", name: "ליגת העל (ישראל)", site: "https://basket.co.il" },
  { id: "lkl", name: "ליגה ליטאית (LKL)", site: "https://lkl.lt" },
  { id: "esake", name: "ליגה יוונית (ESAKE)", site: "https://www.esake.gr" },
  { id: "bsl", name: "ליגה טורקית (BSL)", site: "https://www.tbf.org.tr" },
  { id: "vtb", name: "VTB", site: "https://en.vtb-league.com" },
];

// Paths leagues actually use for this, across languages.
const PROBE = [
  "/calendar-preseason", "/preseason", "/pre-season", "/preseason-calendar",
  "/calendario-pretemporada", "/pretemporada", "/precampionato", "/amichevoli",
  "/calendrier-preparation", "/matchs-amicaux", "/vorbereitung", "/testspiele",
  "/pasiruosimas", "/kontroliniai", "/filika", "/prokrimatika",
  "/hazirlik-maclari", "/mac-programi",
  "/en/preseason", "/en/calendar-preseason", "/games/preseason",
];

// Words that mark a link as the preseason calendar, in the languages involved.
const LINK_WORDS = [
  "preseason", "pre-season", "pretemporada", "precampionato", "amichevoli",
  "préparation", "preparation", "vorbereitung", "testspiele", "pasiruošimo",
  "kontroliniai", "φιλικά", "προετοιμασία", "hazırlık", "pripreme",
  "priprave", "sparingi", "הכנה", "pārbaudes",
];

// A real calendar table has many dates and at least a few club-vs-club rows.
const DATE_ROW = /\b\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}\b|\b\d{1,2}\s+\w{3,}\s+20\d\d\b/g;

function looksLikeCalendar(text) {
  const dates = (text.match(DATE_ROW) || []).length;
  const versus = (text.match(/\s:\s|\bvs\.?\b|\s–\s|\s-\s/g) || []).length;
  return dates >= 5 && versus >= 5;
}

async function findCalendar(league) {
  const tries = [];
  if (league.known) tries.push(league.known);

  const origin = new URL(league.site).origin;
  for (const p of PROBE) tries.push(origin + p, origin + p + "/");

  // Also read the site's own navigation — the surest way to catch a page whose
  // URL we would never have guessed, the day it goes up.
  const home = await get(league.site, { timeout: 20000 });
  if (home) {
    for (const m of home.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi)) {
      const label = m[2].replace(/<[^>]*>/g, " ").toLowerCase();
      const href = decodeURIComponent(m[1]).toLowerCase();
      if (!LINK_WORDS.some((w) => label.includes(w) || href.includes(w))) continue;
      try { tries.push(new URL(m[1], league.site).href); } catch { /* skip */ }
    }
  }

  for (const url of [...new Set(tries)]) {
    const html = await get(url, { timeout: 20000 });
    if (!html) continue;
    const text = toText(html, 30000);
    if (!looksLikeCalendar(text)) continue;
    return { url, text };
  }
  return null;
}

const state = read("leagues.json", { _doc: "League preseason calendar pages, found or still awaited.", leagues: {} });
const found = [];

for (const l of LEAGUES) {
  const remembered = state.leagues[l.id]?.url;
  const hit = await findCalendar(remembered ? { ...l, known: remembered } : l);

  if (!hit) {
    state.leagues[l.id] = { ...(state.leagues[l.id] || {}), name: l.name, site: l.site, url: null,
                            lastChecked: new Date().toISOString() };
    console.log(`  · ${l.name}: no calendar page yet`);
    continue;
  }

  const isNew = !remembered || remembered !== hit.url;
  state.leagues[l.id] = { name: l.name, site: l.site, url: hit.url,
                          firstSeen: state.leagues[l.id]?.firstSeen || new Date().toISOString(),
                          lastChecked: new Date().toISOString() };
  console.log(`  ${isNew ? "NEW" : "ok "} ${l.name}: ${hit.url}`);

  found.push({
    outlet: `league:${l.id}`,
    club: l.name,
    lang: "auto",
    strategy: "league-calendar",
    title: `לוח קדם עונה — ${l.name}`,
    url: hit.url,
    published: null,
    matchedKeywords: ["preseason-calendar"],
    matchedClubs: [],
    // The most authoritative source there is: read it before anything else.
    score: 12,
  });
}

fs.writeFileSync(path.join(DATA, "leagues.json"), JSON.stringify(state, null, 2));

const existing = read("candidates.json", { candidates: [] });
const kept = (existing.candidates || []).filter((c) => !String(c.outlet).startsWith("league:"));
fs.writeFileSync(path.join(DATA, "candidates.json"), JSON.stringify({
  ...existing,
  generated: new Date().toISOString(),
  candidates: [...kept, ...found].sort((a, b) => b.score - a.score),
}, null, 2));

console.log(`\ncalendars live : ${found.length}/${LEAGUES.length}`);
console.log(`still awaited  : ${LEAGUES.length - found.length}`);
