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
 *
 * Probing alone is not enough, and the reason is worth writing down. Five
 * calendars were published and missed, and not one of them for a reason about
 * the page: presaison.lnb.info and padlet.com are not on the league's own
 * origin, and an origin probe cannot leave the origin. Those live in
 * pinned.json, are read every run, and skip the adoption test — a human
 * vouching for a page is a stronger signal than any heuristic here.
 */
import fs from "node:fs";
import path from "node:path";
import { get, pageText, DATE_SHAPE } from "../lib/fetch.mjs";


// A pin that names a broadcaster is that channel's own schedule. It gets its
// own outlet prefix so the extractor treats it as living rather than as an
// article read once and never again.
const tvOutlet = (p) => {
  if (!p.broadcaster) return null;
  try { return "tv:" + new URL(p.url).hostname.replace(/^www\./, ""); }
  catch { return "tv:pinned"; }
};

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

const LINK_TAG = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi;

/**
 * How much a page looks like a fixture list, rather than whether it does.
 *
 * The old test demanded a YEAR in every date, and that is not how calendars
 * are written: lnb prints 27/08, the VTB Super Cup prints 17.09, and both
 * scored zero against a rule the ABA table passed 152 times only because it
 * happens to spell the year out. The year is optional here, exactly as it
 * already was in render.mjs — the two had quietly drifted apart.
 *
 * Loosening the shape means tightening the day and the month in exchange, or
 * the French score column alone would have supplied the dates: 73-93 is a date
 * shape until a month has to be 1..12, and 104-106 until a day has to be 1..31.
 * Scores are also why this counts rather than decides — a page is compared
 * against the other candidates, and the best one wins.
 */
function calendarScore(text) {
  const dates = (text.match(DATE_SHAPE) || []).length;
  const versus = (text.match(/\s:\s|\bvs\.?\b|\s–\s|\s-\s/g) || []).length;
  return dates >= 5 && versus >= 5 ? dates + versus : 0;
}

/**
 * A guessed path that does not exist is not always a 404.
 *
 * lnb.fr and championsleague.basketball answer /calendar-preseason with 200
 * and their HOME PAGE, and a news homepage carries dates and dashes by the
 * dozen. Both were adopted as calendars the moment the date shape stopped
 * demanding a year — the old rule had been rejecting them by accident, which
 * is not the same as guarding against them.
 *
 * The status code cannot see this and no threshold can, because the page is
 * genuinely full of dates. What gives it away is that it is the page already
 * in hand — so ask that directly: take a slice out of the middle of the
 * candidate and look for it in the home page. Comparing the openings is not
 * enough, and this is why the trailing-slash variant still got through after
 * the first attempt: /calendar-preseason and /calendar-preseason/ both serve
 * the home page, but lnb.fr sends a <title> to one and not to the other, so
 * the first 300 characters differed while the other 21,000 did not.
 *
 * ABA is the control. Its calendar shares a site with its home page and no
 * sentence in it.
 */
function isTheHomePage(text, home) {
  if (!home || text.length < 400) return false;
  const at = Math.floor(text.length / 2);
  const middle = text.slice(at, at + 200);
  return middle.length >= 200 && home.includes(middle);
}

async function findCalendar(league) {
  const tries = [];
  if (league.known) tries.push(league.known);

  const origin = new URL(league.site).origin;
  for (const p of PROBE) tries.push(origin + p, origin + p + "/");

  // Also read the site's own navigation — the surest way to catch a page whose
  // URL we would never have guessed, the day it goes up.
  const home = await get(league.site, { timeout: 20000 });
  const homeText = home ? pageText(home, 30000) : "";
  if (home) {
    for (const m of home.matchAll(LINK_TAG)) {
      const label = m[2].replace(/<[^>]*>/g, " ").toLowerCase();
      const href = decodeURIComponent(m[1]).toLowerCase();
      if (!LINK_WORDS.some((w) => label.includes(w) || href.includes(w))) continue;
      try { tries.push(new URL(m[1], league.site).href); } catch { /* skip */ }
    }
  }

  // The best page, not the first that clears the bar. Taking the first meant a
  // probe path that merely answered could shadow the real calendar linked from
  // the menu, and loosening the date shape widens that door.
  let best = null;
  for (const url of [...new Set(tries)]) {
    const html = await get(url, { timeout: 20000 });
    if (!html) continue;
    const text = pageText(html, 30000);
    if (isTheHomePage(text, homeText)) continue;
    const score = calendarScore(text);
    if (score && (!best || score > best.score)) best = { url, score };
  }
  return best;
}

const state = read("leagues.json", { _doc: "League preseason calendar pages, found or still awaited.", leagues: {} });
const pins = read("pinned.json", { pinned: [] }).pinned || [];
// Pins marked for the browser belong to render.mjs. Reading them here would
// spend a fetch to collect the 75 characters legabasket.it sends without one.
const pinnedFor = (id) => pins.filter((p) => p.league === id && !p.browser).map((p) => p.url);
const found = [];

const candidate = (extra) => ({
  lang: "auto", published: null, matchedKeywords: ["preseason-calendar"], matchedClubs: [],
  // The most authoritative source there is: read it before anything else.
  score: 12, ...extra,
});

for (const l of LEAGUES) {
  // A pinned URL is not a guess, so it is not tested, only fetched. It is also
  // not exclusive: probing still runs, so the day a league puts the calendar on
  // its own site the hunter picks that up as well.
  for (const url of pinnedFor(l.id)) {
    found.push(candidate({
      outlet: "league:" + l.id, club: l.name, strategy: "league-calendar-pinned",
      title: "לוח קדם עונה — " + l.name, url,
    }));
    console.log("  PIN " + l.name + ": " + url);
  }

  const remembered = state.leagues[l.id]?.url;
  const hit = await findCalendar(remembered ? { ...l, known: remembered } : l);

  if (!hit) {
    state.leagues[l.id] = { ...(state.leagues[l.id] || {}), name: l.name, site: l.site, url: null,
                            pinned: pinnedFor(l.id), lastChecked: new Date().toISOString() };
    console.log("  ·  " + l.name + ": no calendar page of its own" +
      (pinnedFor(l.id).length ? " (a pinned one is in use)" : ""));
    continue;
  }

  const isNew = !remembered || remembered !== hit.url;
  state.leagues[l.id] = { name: l.name, site: l.site, url: hit.url, pinned: pinnedFor(l.id),
                          firstSeen: state.leagues[l.id]?.firstSeen || new Date().toISOString(),
                          lastChecked: new Date().toISOString() };
  console.log("  " + (isNew ? "NEW" : "ok ") + " " + l.name + ": " + hit.url);

  found.push(candidate({
    outlet: "league:" + l.id, club: l.name, strategy: "league-calendar",
    title: "לוח קדם עונה — " + l.name, url: hit.url,
  }));
}

// Pinned pages belonging to no league slot: a tournament organiser, a ticket
// seller, one club's own announcement. sources.json already names that as the
// category which publishes a draw and its tip-off times before anyone repeats it.
for (const p of pins.filter((x) => !x.league && !x.browser)) {
  found.push(candidate({
    outlet: tvOutlet(p) || "pinned", club: p.name || "", strategy: "pinned",
    title: p.name || p.note || p.url, url: p.url, score: 11,
    // A channel's own schedule names the channel once and never on the rows,
    // and shows one day while listing the rest as tabs. Both facts travel with
    // the candidate rather than being left for the model to infer.
    broadcaster: p.broadcaster || null,
    capturedOn: p.broadcaster ? new Date().toISOString().slice(0, 10) : null,
  }));
  console.log("  PIN " + (p.name || p.url));
}

fs.writeFileSync(path.join(DATA, "leagues.json"), JSON.stringify(state, null, 2));

const existing = read("candidates.json", { candidates: [] });
const kept = (existing.candidates || [])
  .filter((c) => !String(c.outlet).startsWith("league:") && c.outlet !== "pinned");
fs.writeFileSync(path.join(DATA, "candidates.json"), JSON.stringify({
  ...existing,
  generated: new Date().toISOString(),
  candidates: [...kept, ...found].sort((a, b) => b.score - a.score),
}, null, 2));

const slots = new Set(found.filter((f) => f.outlet !== "pinned").map((f) => f.outlet)).size;
console.log("\ncalendars live : " + slots + "/" + LEAGUES.length + " leagues");
console.log("pages to read  : " + found.length);
