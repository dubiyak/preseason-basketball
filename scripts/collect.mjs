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
  const feed = await findFeed(o.url);
  if (!feed) { health.push({ id: o.id, ok: false, why: "no feed found" }); continue; }

  const xml = await get(feed);
  if (!xml) { health.push({ id: o.id, ok: false, why: "feed unreachable", feed }); continue; }

  const items = parseItems(xml);
  let hits = 0;
  for (const it of items) {
    const { kw, clubs } = classify({ ...it, url: it.link }, o);
    if (!kw.length && !clubs.length) continue;
    hits++;
    results.push({
      outlet: o.id, lang: o.lang, title: it.title, url: it.link,
      published: it.date, matchedKeywords: kw, matchedClubs: clubs,
      // keyword AND a known club is a much stronger signal than either alone
      score: (kw.length ? 2 : 0) + (clubs.length ? 2 : 0) + Math.min(kw.length + clubs.length, 3),
    });
  }
  health.push({ id: o.id, ok: true, feed, items: items.length, candidates: hits });
}

results.sort((a, b) => b.score - a.score);
fs.writeFileSync(
  path.join(DATA, "candidates.json"),
  JSON.stringify({ generated: new Date().toISOString(), health, candidates: results }, null, 2)
);

const live = health.filter((h) => h.ok);
console.log(`feeds reachable  : ${live.length}/${health.length}`);
console.log(`items scanned    : ${live.reduce((n, h) => n + h.items, 0)}`);
console.log(`candidates       : ${results.length}`);
for (const h of health.filter((h) => !h.ok)) console.log(`  ! ${h.id}: ${h.why}`);
console.log("");
for (const r of results.slice(0, 25)) {
  console.log(`[${r.score}] ${r.outlet} · ${r.title.slice(0, 78)}`);
  if (r.matchedClubs.length) console.log(`      clubs: ${r.matchedClubs.slice(0, 4).join(", ")}`);
}
