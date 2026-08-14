/**
 * One-off deep crawl of the archives.
 *
 * The feeds only reach back a day — Sportando's rolls over in under one — so
 * the routine collector can only ever see what was published since it last
 * ran. But most preseason schedules were announced in June and July. The
 * Nicosia draw went up on 26 June; by the time this project existed it had
 * long fallen off every feed.
 *
 * Sitemaps do reach back. This walks them, keeps URLs from the announcement
 * window whose slug reads like a fixture story, and hands them to the same
 * extractor. Articles are immutable, so once read they are never read again
 * and this becomes cheap to repeat.
 */
import fs from "node:fs";
import path from "node:path";
import { get } from "../lib/fetch.mjs";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const read = (f, fb) =>
  fs.existsSync(path.join(DATA, f)) ? JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")) : fb;

const FROM = process.env.BACKFILL_FROM || "2026-06-01";
const TO = process.env.BACKFILL_TO || "2026-12-31";
const MAX_SITEMAPS = Number(process.env.MAX_SITEMAPS || 12);

const sources = read("sources.json", { outlets: [], keywords: {} });
const teams = read("teams.json", { teams: [] }).teams;

/**
 * A slug carries far less context than a headline, so the wide net the live
 * collector uses does not transfer. "turnir", "turnīrs" and "calendario" are
 * just "tournament" and "calendar" in three languages: on a first pass they
 * matched 617 stories, most of them domestic cup reports in Latvia.
 *
 * Words that only ever mean preseason stand alone. Generic ones need a club
 * name in the same slug to count.
 */
const GENERIC = new Set([
  "turnir", "turnīrs", "turnyras", "turnuva", "tournoi", "turniej", "τουρνουά",
  "calendario", "calendar", "friendly", "friendlies", "particular", "amigável",
  "prijateljska", "draugiškos", "kontrolinis", "kontrolinės",
]);

const norm = (k) => k.toLowerCase().replace(/\s+/g, "-");
const allWords = [...new Set(Object.entries(sources.keywords)
  .filter(([k]) => !k.startsWith("_"))
  .flatMap(([, v]) => v))].map(norm);

const STRONG = allWords.filter((k) => !GENERIC.has(k));
const WEAK = allWords.filter((k) => GENERIC.has(k));

// Club names as they appear in a slug: lowercased, spaces to hyphens, no
// diacritics. A Hebrew name never appears in a Latin URL, so only the source
// spellings are useful here.
const CLUB_SLUGS = [...new Set(teams.flatMap((t) => [t.name_src, ...(t.aliases || [])]))]
  .filter((n) => n && /[a-z]/i.test(n) && n.length > 4)
  .map((n) => n.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-"))
  .filter((s) => s.length > 4);

const SITEMAP_PATHS = [
  "/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml",
  "/news-sitemap.xml", "/sitemap-news.xml", "/post-sitemap.xml",
];

const strip = (s) => String(s || "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]*>/g, "").trim();

/** Collect <loc> entries with their lastmod, following one level of index. */
async function urlsFrom(origin) {
  const out = [];
  for (const p of SITEMAP_PATHS) {
    const xml = await get(origin + p, { timeout: 25000 });
    if (!xml || !/<urlset|<sitemapindex/i.test(xml)) continue;

    let sheets = [origin + p];
    if (/<sitemapindex/i.test(xml)) {
      const kids = [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map((m) => strip(m[1]));
      // Prefer the recent ones: sitemaps are usually named or dated in order.
      sheets = kids
        .filter((u) => /news|post|article|2026/i.test(u))
        .slice(-MAX_SITEMAPS);
      if (!sheets.length) sheets = kids.slice(-MAX_SITEMAPS);
    }

    for (const sheet of sheets) {
      const body = sheet === origin + p && !/<sitemapindex/i.test(xml)
        ? xml
        : await get(sheet, { timeout: 25000 });
      if (!body) continue;
      for (const m of body.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
        const loc = strip((m[1].match(/<loc>([\s\S]*?)<\/loc>/i) || [])[1]);
        const mod = strip((m[1].match(/<lastmod>([\s\S]*?)<\/lastmod>/i) || [])[1]).slice(0, 10);
        const title = strip((m[1].match(/<news:title>([\s\S]*?)<\/news:title>/i) || [])[1]);
        if (loc) out.push({ loc, mod, title });
      }
    }
    if (out.length) break;
  }
  return out;
}

/** In window by lastmod, or by a yyyy/mm the outlet puts in the path. */
function inWindow({ loc, mod }) {
  if (mod && /^\d{4}-\d{2}-\d{2}$/.test(mod)) return mod >= FROM && mod <= TO;
  const m = loc.match(/\/(20\d\d)\/(\d{2})\//);
  if (m) {
    const d = `${m[1]}-${m[2]}-15`;
    return d >= FROM && d <= TO;
  }
  return true; // undated: let the slug filter decide
}

const found = [];
const health = [];

for (const o of sources.outlets) {
  let origin;
  try { origin = new URL(o.url).origin; } catch { continue; }

  const urls = await urlsFrom(origin);
  if (!urls.length) { health.push({ id: o.id, ok: false }); continue; }

  let hits = 0;
  for (const u of urls) {
    if (!inWindow(u)) continue;
    const slug = decodeURIComponent(u.loc).toLowerCase();
    const hay = slug + " " + (u.title || "").toLowerCase();

    const strong = STRONG.filter((k) => hay.includes(k));
    const weak = WEAK.filter((k) => hay.includes(k));
    const clubs = CLUB_SLUGS.filter((c) => slug.includes(c));

    // Strong on its own; generic only alongside a club we track.
    if (!strong.length && !(weak.length && clubs.length)) continue;
    const kw = [...strong, ...(clubs.length ? weak : [])];

    hits++;
    found.push({
      outlet: o.id, lang: o.lang, strategy: "backfill",
      title: u.title || decodeURIComponent(u.loc).split("/").filter(Boolean).pop().replace(/[-_]+/g, " "),
      url: u.loc, published: u.mod || null,
      matchedKeywords: kw, matchedClubs: clubs,
      // Below anything live: an archive article is not going to change, so it
      // waits its turn behind today's fixture pages.
      score: (strong.length ? 2 : 0) + (clubs.length ? 1 : 0),
    });
  }
  health.push({ id: o.id, ok: true, scanned: urls.length, candidates: hits });
  console.log(`  ${o.id.padEnd(20)} ${String(urls.length).padStart(5)} urls → ${hits}`);
}

const existing = read("candidates.json", { candidates: [] });
const known = new Set((existing.candidates || []).map((c) => c.url));
const fresh = found.filter((f) => !known.has(f.url));

fs.writeFileSync(path.join(DATA, "candidates.json"), JSON.stringify({
  ...existing,
  generated: new Date().toISOString(),
  backfillHealth: health,
  candidates: [...(existing.candidates || []), ...fresh].sort((a, b) => b.score - a.score),
}, null, 2));

console.log(`\nsitemaps read : ${health.filter((h) => h.ok).length}/${health.length}`);
console.log(`window        : ${FROM} → ${TO}`);
console.log(`new candidates: ${fresh.length} (${found.length - fresh.length} already known)`);
