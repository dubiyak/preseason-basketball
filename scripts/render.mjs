/**
 * Renders the club pages that plain fetching cannot read.
 *
 * Measured, not assumed: thelondonlions.com/schedule, zalgiris.lt/rungtynes
 * and baskonia.com/en/schedule all answer 200 with thousands of characters and
 * ZERO dates. The fixture list is injected by JavaScript after load, so no
 * amount of better parsing reaches it. London Lions even links the page from
 * its home nav with the text "Fixtures" — discovery found it correctly and
 * there was simply nothing there to read.
 *
 * A real browser fixes exactly that and nothing else, so it is used only for
 * the clubs where fetching already failed. Everything reachable without one
 * stays on the cheap path.
 */
import fs from "node:fs";
import path from "node:path";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const read = (f, fb) =>
  fs.existsSync(path.join(DATA, f)) ? JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")) : fb;

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.log("playwright not installed — skipping. npm i -D playwright && npx playwright install chromium");
  process.exit(0);
}

const registry = read("registry.json", { clubs: {} });
const teams = new Map(read("teams.json", { teams: [] }).teams.map((t) => [t.id, t]));

const FIXTURE_PATHS = [
  "/schedule", "/games", "/fixtures", "/matches", "/calendario", "/calendrier",
  "/rungtynes", "/spielplan", "/programma", "/mac-programi", "/raspored",
  "/en/schedule", "/en/games", "/en/fixtures", "/calendar",
];
const DATE_SHAPE = /\b\d{1,2}[.\/-]\d{1,2}([.\/-]\d{2,4})?\b/g;

// Only clubs whose page was never found, or was found but read as empty.
const targets = Object.entries(registry.clubs)
  .filter(([, c]) => c.website && !c.fixturesUrl)
  .map(([id, c]) => ({ id, ...c, name: teams.get(id)?.name_he || c.name_src || id }));

console.log(`clubs needing a browser: ${targets.length}`);
if (!targets.length) process.exit(0);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  locale: "en-GB",
  viewport: { width: 1280, height: 2000 },
});
// Images and fonts are pure cost here: nothing is looked at, only read.
await ctx.route("**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,mp4}", (r) => r.abort());

const found = [];
const health = [];

for (const club of targets) {
  let origin;
  try { origin = new URL(club.website).origin; } catch { continue; }

  let hit = null;
  for (const p of FIXTURE_PATHS) {
    const page = await ctx.newPage();
    try {
      await page.goto(origin + p, { waitUntil: "domcontentloaded", timeout: 25000 });
      // The fixture list arrives after load; wait for a date to appear rather
      // than for a fixed delay.
      await page.waitForFunction(
        () => /\b\d{1,2}[.\/-]\d{1,2}\b/.test(document.body?.innerText || ""),
        { timeout: 9000 }
      ).catch(() => {});
      const text = (await page.innerText("body").catch(() => "")) || "";
      const dates = (text.match(DATE_SHAPE) || []).length;
      if (dates >= 4 && text.length > 400) hit = { url: origin + p, text: text.slice(0, 18000), dates };
    } catch { /* try the next path */ }
    await page.close();
    if (hit) break;
  }

  if (!hit) { health.push({ club: club.name, ok: false }); continue; }

  registry.clubs[club.id].fixturesUrl = hit.url;
  registry.clubs[club.id].needsBrowser = true;
  health.push({ club: club.name, ok: true, url: hit.url, dates: hit.dates });
  console.log(`  ✓ ${club.name} — ${hit.url} (${hit.dates} dates)`);

  found.push({
    outlet: `club:${club.id}`,
    club: club.name,
    lang: "auto",
    strategy: "club-page-rendered",
    title: `לוח משחקים — ${club.name}`,
    url: hit.url,
    published: null,
    // The rendered text travels with the candidate: fetching this URL again
    // without a browser would return the same empty shell.
    inlineText: hit.text,
    matchedKeywords: ["fixtures-page"],
    matchedClubs: [club.name],
    score: 9,
  });
}

await browser.close();
fs.writeFileSync(path.join(DATA, "registry.json"), JSON.stringify(registry, null, 2));

const existing = read("candidates.json", { candidates: [] });
const kept = (existing.candidates || []).filter((c) => c.strategy !== "club-page-rendered");
fs.writeFileSync(path.join(DATA, "candidates.json"), JSON.stringify({
  ...existing,
  generated: new Date().toISOString(),
  renderHealth: health,
  candidates: [...kept, ...found].sort((a, b) => b.score - a.score),
}, null, 2));

console.log(`\nrendered ok : ${found.length}/${targets.length}`);
console.log(`still dark  : ${targets.length - found.length}`);
