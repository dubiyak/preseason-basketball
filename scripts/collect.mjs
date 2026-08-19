/**
 * Layer 1 collector: sweep the outlet feeds and surface candidate articles.
 *
 * This stage is deliberately recall-oriented. It decides only "might this
 * article contain fixtures", never "what are the fixtures" — extraction is a
 * separate step. An item is a candidate if its headline matches the outlet's
 * language keywords OR mentions any club in the registry. Club names are
 * language-independent, which is what covers the keywords we failed to guess.
 */
import fs from "node:fs";
import path from "node:path";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const UA = "Mozilla/5.0 (compatible; preseason-basketball/1.0; +https://github.com/dubiyak/preseason-basketball)";
const TIMEOUT = 15000;
const FEED_PATHS = ["/feed/", "/feed", "/rss", "/rss.xml", "/en/feed/", "/feed/rss"];

const sources = JSON.parse(fs.readFileSync(path.join(DATA, "sources.json"), "utf8"));
const teams = JSON.parse(fs.readFileSync(path.join(DATA, "teams.json"), "utf8")).teams;

async function get(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: "follow",
      headers: { "User-Agent": UA, "Accept": "*/*" },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Declared feed first, guessed paths second. ~30% declare, ~50% more answer a guess. */
async function findFeed(homeUrl) {
  const home = await get(homeUrl);
  if (home) {
    const m = home.match(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/i);
    const href = m && m[0].match(/href=["']([^"']+)["']/i);
    if (href) return new URL(href[1], homeUrl).href;
  }
  const base = new URL(homeUrl).origin;
  for (const p of FEED_PATHS) {
    const body = await get(base + p);
    if (body && /<rss|<feed/i.test(body)) return base + p;
  }
  return null;
}

const strip = (s) =>
  String(s || "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&").replace(/&#8217;|&#8216;/g, "'")
    .replace(/&#8220;|&#8221;|&quot;/g, '"').replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .trim();

function parseItems(xml) {
  const blocks = [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  return blocks.map((b) => {
    const title = strip((b.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
    let link = strip((b.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1]);
    if (!link) link = ((b.match(/<link[^>]+href=["']([^"']+)["']/i) || [])[1] || "").trim();
    const date = strip(
      (b.match(/<(?:pubDate|published|updated)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated)>/i) || [])[1]
    );
    const summary = strip(
      (b.match(/<(?:description|summary)[^>]*>([\s\S]*?)<\/(?:description|summary)>/i) || [])[1]
    ).slice(0, 400);
    return { title, link, date, summary };
  }).filter((i) => i.title && i.link);
}

/* ---------- strategy 2: sitemaps ---------- */
// Deeper than a feed by design. A feed holds the last ~10 items — Sportando's
// rolls over in under a day — so anything announced last month is only
// reachable this way. News sitemaps also carry a title; plain ones do not, and
// there the URL slug is all we get to match on.
const SITEMAP_PATHS = ["/news-sitemap.xml", "/sitemap-news.xml", "/sitemap.xml", "/sitemap_index.xml"];

async function fromSitemap(homeUrl) {
  const base = new URL(homeUrl).origin;
  for (const p of SITEMAP_PATHS) {
    let xml = await get(base + p);
    if (!xml || !/<urlset|<sitemapindex/i.test(xml)) continue;

    // An index points at further sitemaps; follow the most recent news-ish one.
    if (/<sitemapindex/i.test(xml)) {
      const kids = [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map((m) => strip(m[1]));
      const pick = kids.find((u) => /news|post|article|20\d\d/i.test(u)) || kids[kids.length - 1];
      if (!pick) continue;
      xml = await get(pick);
      if (!xml) continue;
    }

    const items = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)].map((m) => {
      const b = m[1];
      const link = strip((b.match(/<loc>([\s\S]*?)<\/loc>/i) || [])[1]);
      const title = strip((b.match(/<news:title>([\s\S]*?)<\/news:title>/i) || [])[1]);
      const date = strip(
        (b.match(/<(?:news:publication_date|lastmod)>([\s\S]*?)<\/(?:news:publication_date|lastmod)>/i) || [])[1]
      );
      // Without a title the slug carries the words; it is what the filter reads.
      const slugWords = link ? decodeURIComponent(link).split("/").pop().replace(/[-_]+/g, " ").replace(/\.\w+$/, "") : "";
      return { title: title || slugWords, link, date, summary: title ? "" : slugWords };
    }).filter((i) => i.link && i.title);

    if (items.length) return { items: items.slice(0, 400), via: base + p };
  }
  return null;
}

/* ---------- strategy 3: scrape the news index ---------- */
// Last resort, and the one that always exists: a news page is still HTML.
async function fromHtml(pageUrl) {
  const html = await get(pageUrl);
  if (!html) return null;
  const origin = new URL(pageUrl).origin;

  const seen = new Set();
  const items = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let href = m[1];
    const text = strip(m[2]).replace(/\s+/g, " ");
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) continue;

    let url;
    try { url = new URL(href, pageUrl); } catch { continue; }
    if (url.origin !== origin) continue;

    // An article URL has a slug; navigation links do not.
    const last = url.pathname.split("/").filter(Boolean).pop() || "";
    const looksLikeArticle = /[-_]/.test(last) && last.length > 12;
    if (!looksLikeArticle || text.length < 12) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);

    const slugWords = decodeURIComponent(last).replace(/[-_]+/g, " ").replace(/\.\w+$/, "");
    items.push({ title: text, link: url.href, date: "", summary: slugWords });
  }
  return items.length ? { items: items.slice(0, 300), via: pageUrl } : null;
}

/** RSS, then sitemap, then the news page itself. Records which one worked. */
async function discover(outlet) {
  const feed = await findFeed(outlet.url);
  if (feed) {
    const xml = await get(feed);
    const items = xml ? parseItems(xml) : [];
    if (items.length) return { items, via: feed, strategy: "rss" };
  }
  const sm = await fromSitemap(outlet.url);
  if (sm) return { ...sm, strategy: "sitemap" };

  const html = await fromHtml(outlet.url);
  if (html) return { ...html, strategy: "html" };

  return null;
}

// Registry names, longest first so "מכבי תל אביב" wins over "מכבי".
const CLUB_TOKENS = [...new Set(teams.flatMap((t) => [t.name_he, t.name_src, ...(t.aliases || [])]))]
  .filter((n) => n && n.length > 3)
  .sort((a, b) => b.length - a.length);

const SPORT_CONTEXT = sources.keywords._sport_context || [];

/**
 * On a basketball-only outlet a club name is signal on its own. On a general
 * sports site it is not: the first run matched football transfer stories on
 * "ברצלונה" and a weather report on "Sabah", which is simply the Turkish word
 * for morning. There, a club name needs a basketball term beside it.
 */
function classify(item, outlet) {
  const hay = (item.title + " " + item.summary).toLowerCase();
  const kw = (sources.keywords[outlet.lang] || []).concat(sources.keywords.en)
    .filter((k) => hay.includes(k.toLowerCase()));
  let clubs = CLUB_TOKENS.filter((c) => hay.includes(c.toLowerCase()));

  const hasSport = outlet.basketballOnly ||
    SPORT_CONTEXT.some((w) => hay.includes(w)) ||
    /\/(basket|kosarka|kosarka|krepsinis|basketbols)\//i.test(item.url || "");
  if (!hasSport) clubs = [];

  return { kw, clubs, hasSport };
}

const results = [];
const health = [];

for (const o of sources.outlets) {
  const found = await discover(o);
  if (!found) { health.push({ id: o.id, ok: false, why: "no feed, sitemap or article links" }); continue; }

  let hits = 0;
  for (const it of found.items) {
    const { kw, clubs } = classify({ ...it, url: it.link }, o);
    if (!kw.length && !clubs.length) continue;
    hits++;
    results.push({
      outlet: o.id, lang: o.lang, strategy: found.strategy,
      title: it.title, url: it.link, published: it.date,
      matchedKeywords: kw, matchedClubs: clubs,
      // keyword AND a known club is a much stronger signal than either alone
      score: (kw.length ? 2 : 0) + (clubs.length ? 2 : 0) + Math.min(kw.length + clubs.length, 3),
    });
  }
  health.push({ id: o.id, ok: true, strategy: found.strategy, via: found.via,
                items: found.items.length, candidates: hits });
}

results.sort((a, b) => b.score - a.score);
/**
 * Keep what the other collectors found.
 *
 * This used to write only its own results, which silently deleted every
 * candidate produced by a layer that runs BEFORE it — and leagues.mjs is
 * step one. The ABA preseason calendar, the single most complete source in
 * the project, was being dropped on every run and had not been re-read for
 * five days. Its results were sitting on the page the whole time.
 */
const previous = fs.existsSync(path.join(DATA, "candidates.json"))
  ? JSON.parse(fs.readFileSync(path.join(DATA, "candidates.json"), "utf8"))
  : { candidates: [] };

// Anything not produced by this sweep is another layer's, and stays.
const mine = new Set(sources.outlets.map((o) => o.id));
const keep = (previous.candidates || []).filter((c) => !mine.has(String(c.outlet)));

fs.writeFileSync(
  path.join(DATA, "candidates.json"),
  JSON.stringify({
    ...previous,
    generated: new Date().toISOString(),
    health,
    candidates: [...keep, ...results].sort((a, b) => b.score - a.score),
  }, null, 2)
);

const live = health.filter((h) => h.ok);
const by = (s) => live.filter((h) => h.strategy === s).length;
console.log(`outlets reached  : ${live.length}/${health.length}   (rss ${by("rss")} · sitemap ${by("sitemap")} · html ${by("html")})`);
console.log(`items scanned    : ${live.reduce((n, h) => n + h.items, 0)}`);
console.log(`candidates       : ${results.length}`);
for (const h of health.filter((h) => !h.ok)) console.log(`  ! ${h.id}: ${h.why}`);
console.log("");
for (const r of results.slice(0, 25)) {
  console.log(`[${r.score}] ${r.outlet} · ${r.title.slice(0, 78)}`);
  if (r.matchedClubs.length) console.log(`      clubs: ${r.matchedClubs.slice(0, 4).join(", ")}`);
}
