/**
 * Renders the club fixture pages that plain fetching cannot read.
 *
 * Measured, not assumed: thelondonlions.com/schedule, zalgiris.lt/rungtynes
 * and baskonia.com/en/schedule all answer 200 with thousands of characters and
 * ZERO dates. The fixture list is injected by JavaScript after load, so no
 * amount of better parsing reaches it.
 *
 * Two earlier versions failed on cost, not on concept. Guessing fifteen paths
 * per club meant 400+ full renders; guessing seven still spent twelve minutes
 * to open one club, because a site that hangs consumes its whole timeout every
 * time. The expensive part was never the rendering — it was not knowing which
 * page to render.
 *
 * So the browser renders each home page ONCE, and the model reads the link
 * list and says which one is the fixtures page. That is the same trick used
 * everywhere else in this project, and for the same reason: it does not need
 * to know that "rungtynės", "fikstür" and "πρόγραμμα" all mean schedule.
 */
import fs from "node:fs";
import path from "node:path";


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

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.log("playwright not installed — skipping. npm i -D playwright && npx playwright install chromium");
  process.exit(0);
}

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
const KEY = loadKey();
const MODELS = (process.env.GEMINI_MODELS ||
  "gemini-flash-latest,gemini-flash-lite-latest,gemini-3-flash-preview,gemini-3.1-flash-lite-preview")
  .split(",").map((s) => s.trim());

const registry = read("registry.json", { clubs: {} });
const teams = new Map(read("teams.json", { teams: [] }).teams.map((t) => [t.id, t]));

const DATE_SHAPE = /\b\d{1,2}[.\/-]\d{1,2}([.\/-]\d{2,4})?\b/g;
const PAGE_MS = 12000;
const TOTAL_BUDGET_MS = Number(process.env.RENDER_TOTAL_MS || 14 * 60000);
const startedAt = Date.now();
const overBudget = () => Date.now() - startedAt > TOTAL_BUDGET_MS;

const targets = Object.entries(registry.clubs)
  .filter(([, c]) => c.website && !c.fixturesUrl)
  .map(([id, c]) => ({ id, ...c, name: teams.get(id)?.name_he || c.name_src || id }));

// Read before the early exit, or a day when every club has a fixtures page
// would take the pinned league calendars down with it.
const browserPins = (read("pinned.json", { pinned: [] }).pinned || []).filter((p) => p.browser);

console.log(`clubs needing a browser: ${targets.length} · pinned pages: ${browserPins.length}`);
if (!targets.length && !browserPins.length) process.exit(0);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  locale: "en-GB",
  viewport: { width: 1280, height: 2000 },
});
// Nothing here is looked at, only read.
await ctx.route("**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,mp4,mp3}", (r) => r.abort());

async function render(url, waitForDate) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_MS });
    if (waitForDate) {
      await page.waitForFunction(
        () => /\b\d{1,2}[.\/-]\d{1,2}\b/.test(document.body?.innerText || ""),
        { timeout: 6000 }
      ).catch(() => {});
    }
    const text = (await page.innerText("body").catch(() => "")) || "";
    const links = waitForDate ? [] : await page.$$eval("a[href]", (as) =>
      as.map((a) => ({ href: a.href, text: (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 50) }))
        .filter((l) => l.text)).catch(() => []);
    return { text, links };
  } catch {
    return null;
  } finally {
    await page.close();
  }
}

/* ---------- 1. one render per home page, to collect its links ---------- */
const menus = [];
for (const club of targets) {
  if (overBudget()) break;
  let origin;
  try { origin = new URL(club.website).origin; } catch { continue; }

  const home = await render(origin, false);
  if (!home?.links.length) { console.log(`  · ${club.name}: home page unreadable`); continue; }

  // Same-origin links only, deduped, and never the obvious non-fixture areas.
  const seen = new Set();
  const links = [];
  for (const l of home.links) {
    let u;
    try { u = new URL(l.href); } catch { continue; }
    if (u.origin !== origin || seen.has(u.pathname)) continue;
    if (/\b(shop|store|ticket|sponsor|academy|youth|women|privacy|cookie)\b/i.test(u.pathname)) continue;
    seen.add(u.pathname);
    links.push({ text: l.text, path: u.pathname + u.search });
  }
  if (links.length) menus.push({ club, origin, links: links.slice(0, 70) });
}
console.log(`home pages read: ${menus.length}/${targets.length}`);

/* ---------- 2. the model picks the fixtures link ---------- */
const SCHEMA = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          club: { type: "string", description: "the club name, copied back exactly" },
          path: { type: "string", description: "the path of the fixtures page, copied exactly from the list, or empty if none of them is one" },
        },
        required: ["club", "path"],
      },
    },
  },
  required: ["picks"],
};

const PROMPT = `You are given the navigation links of basketball club websites. For each club, pick the ONE link that leads to its list of games — fixtures, schedule, calendar, results.

The sites are in many languages: "rungtynės" (Lithuanian), "fikstür" and "maçlar" (Turkish), "πρόγραμμα" (Greek), "raspored" and "utakmice" (Serbian/Croatian), "calendario" (Spanish/Italian), "calendrier" (French), "Spielplan" (German), "spēles" (Latvian), "terminarz" (Polish), "משחקים" (Hebrew). Judge by meaning, not by matching English words.

Rules:
- Copy the path EXACTLY as it appears in the list. Never invent one.
- Prefer the first team's fixture list over a youth, women's or academy one, and over a single match page.
- A news, ticket, shop or standings link is not a fixture list. If nothing in the list is one, return an empty path rather than a guess.`;

async function pickLinks(batch) {
  if (!KEY) return {};
  const body = batch.map((m) =>
    `CLUB: ${m.club.name}\nLINKS:\n${m.links.map((l) => `  ${l.path}  —  ${l.text}`).join("\n")}`
  ).join("\n\n");

  for (const model of MODELS) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: PROMPT }] },
          contents: [{ parts: [{ text: body }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: SCHEMA },
        }),
      }
    );
    if (res.status === 429) continue;
    if (!res.ok) continue;
    const j = await res.json();
    const raw = j?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) continue;
    try {
      const picks = JSON.parse(raw).picks || [];
      return Object.fromEntries(picks.map((p) => [p.club, p.path]));
    } catch { continue; }
  }
  return {};
}

const chosen = {};
for (let i = 0; i < menus.length; i += 6) {
  Object.assign(chosen, await pickLinks(menus.slice(i, i + 6)));
}
console.log(`links chosen   : ${Object.values(chosen).filter(Boolean).length}`);

/* ---------- 3. render the chosen page and keep it if it has fixtures ---------- */
const found = [];
const health = [];

function save() {
  fs.writeFileSync(path.join(DATA, "registry.json"), JSON.stringify(registry, null, 2));
  const existing = read("candidates.json", { candidates: [] });
  const kept = (existing.candidates || [])
    .filter((c) => c.strategy !== "club-page-rendered" && c.strategy !== "pinned-rendered");
  fs.writeFileSync(path.join(DATA, "candidates.json"), JSON.stringify({
    ...existing,
    generated: new Date().toISOString(),
    renderHealth: health,
    candidates: [...kept, ...found].sort((a, b) => b.score - a.score),
  }, null, 2));
}

for (const m of menus) {
  if (overBudget()) { console.log("  … budget spent; the rest wait for the next run"); break; }
  const p = chosen[m.club.name];
  if (!p) { health.push({ club: m.club.name, ok: false, why: "no fixtures link" }); continue; }

  const url = new URL(p, m.origin).href;
  const page = await render(url, true);
  const dates = ((page?.text || "").match(DATE_SHAPE) || []).length;
  if (!page || dates < 4) {
    health.push({ club: m.club.name, ok: false, why: `rendered but ${dates} dates`, url });
    continue;
  }

  registry.clubs[m.club.id].fixturesUrl = url;
  registry.clubs[m.club.id].needsBrowser = true;
  health.push({ club: m.club.name, ok: true, url, dates });
  console.log(`  ✓ ${m.club.name} — ${url} (${dates} dates)`);

  found.push({
    outlet: `club:${m.club.id}`,
    club: m.club.name,
    lang: "auto",
    strategy: "club-page-rendered",
    title: `לוח משחקים — ${m.club.name}`,
    url,
    published: null,
    // The rendered text travels with the candidate: fetching this URL again
    // without a browser returns the same empty shell.
    inlineText: page.text.slice(0, 18000),
    matchedKeywords: ["fixtures-page"],
    matchedClubs: [m.club.name],
    score: 9,
  });
  save();
}

/* ---------- 4. pinned calendars that only a browser can read ---------- */
// legabasket.it publishes the whole Italian preseason at a news URL whose body
// arrives empty: 105KB of HTML, 75 characters of text, and a __NEXT_DATA__ that
// holds nothing but the page title. The German board is a padlet, which is the
// same story. Neither is a club, so the loop above never sees them, and neither
// can be fixed by better parsing — the fixtures are simply not sent.
//
// Marked in pinned.json rather than detected, because "a plain fetch read too
// little" and "this page needs a browser" are not the same claim, and only one
// of them is worth spending a render on.
let pinned = 0;

for (const p of browserPins) {
  if (overBudget()) { console.log("  … budget spent; pinned pages wait for the next run"); break; }
  const page = await render(p.url, true);
  const text = page?.text || "";
  // Judged on having text, not on having dates. The club loop above counts
  // date shapes because it is deciding whether a guessed link is the fixtures
  // page at all; here a human already answered that. And the count would be
  // wrong anyway: legabasket writes "Sabato 29 agosto ore 17.30", so the whole
  // Italian preseason — all sixteen clubs, with times, venues and tournaments —
  // scores four numeric dates and came within one of being thrown away. A date
  // shape is a manual pattern, and every manual pattern here has been partial.
  if (text.length < 800) {
    health.push({ club: p.name || p.league, ok: false, why: `rendered but ${text.length} chars`, url: p.url });
    console.log(`  ✗ ${p.name || p.league} — ${text.length} chars after rendering`);
    continue;
  }
  const dates = (text.match(DATE_SHAPE) || []).length;
  health.push({ club: p.name || p.league, ok: true, url: p.url, dates, chars: text.length });
  console.log(`  ✓ ${p.name || p.league} — ${p.url} (${text.length} chars, ${dates} numeric dates)`);
  pinned++;
  found.push({
    outlet: tvOutlet(p) || (p.league ? `league:${p.league}` : "pinned"),
    club: p.name || "",
    lang: "auto",
    strategy: "pinned-rendered",
    title: p.name || p.note || p.url,
    // A channel's own schedule names the channel once, at the top, and never
    // on the rows. It rides on the pin so every game read off the page can be
    // attributed without the model having to infer it from a page header.
    broadcaster: p.broadcaster || null,
    // The day the page was showing. A rendered page carries no date of its own,
    // and this one renders its listing TWICE — the same rows appear in two
    // blocks — so the model saw one fixture and reasonably filed the second
    // copy under another day. It is not a judgement call: a schedule shows one
    // day, and the renderer is the only thing that knows which.
    capturedOn: p.broadcaster ? new Date().toISOString().slice(0, 10) : null,
    url: p.url,
    published: null,
    // Same reason as above: fetching this URL again without a browser returns
    // the same empty shell.
    //
    // A schedule is stamped with the day it was read. The page shows ONE day's
    // rows and lists every other day as a tab beside them, and the model dated
    // a row to a tab — putting Hapoel Tel Aviv against Balkan on the 4th of
    // September as well as tonight, from a page that only ever showed tonight.
    // A rendered page carries no date of its own; this is the one thing the
    // renderer knows that the text does not say.
    inlineText: (p.broadcaster
      ? `[הדף נלכד ב-${new Date().toISOString().slice(0, 10)}]\n`
      : "") + text.slice(0, 18000),
    matchedKeywords: ["preseason-calendar"],
    matchedClubs: [],
    score: 12,
  });
  save();
}

await browser.close();
save();
console.log(`\nrendered ok : ${found.length - pinned}/${targets.length} clubs · ${pinned}/${browserPins.length} pinned`);
console.log(`still dark  : ${targets.length - (found.length - pinned)}`);
