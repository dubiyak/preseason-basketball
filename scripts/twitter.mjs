/**
 * Layer 3: the clubs' own social feeds.
 *
 * I said this was closed and it is not. X's own API is priced out of reach,
 * but Nitter mirrors expose a plain RSS feed per account, and the EuroLeague
 * API already handed over the handle for 46 clubs. A club posts its draw or
 * its tip-off time here before anyone writes it up.
 *
 * Mirrors go down constantly, which is the real cost. So: several are tried in
 * turn, a failure of all of them is reported rather than swallowed, and this
 * layer is strictly additive — nothing else depends on it working.
 */
import fs from "node:fs";
import path from "node:path";
import { get } from "../lib/fetch.mjs";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const read = (f, fb) =>
  fs.existsSync(path.join(DATA, f)) ? JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")) : fb;

const MIRRORS = (process.env.NITTER_MIRRORS ||
  "nitter.net,nitter.privacyredirect.com,xcancel.com,nitter.poast.org")
  .split(",").map((s) => s.trim()).filter(Boolean);

const sources = read("sources.json", { keywords: {} });
const registry = read("registry.json", { clubs: {} });
const teams = new Map(read("teams.json", { teams: [] }).teams.map((t) => [t.id, t]));

const KEYWORDS = [...new Set(Object.entries(sources.keywords)
  .filter(([k]) => !k.startsWith("_"))
  .flatMap(([, v]) => v))].map((k) => k.toLowerCase());

// A tweet is a few words, so a fixture announcement is recognised by its shape
// as much as its wording: a date, a time, or a scoreline.
const SHAPE = /\d{1,2}[.\/]\d{1,2}|\d{1,2}:\d{2}|\b\d{2,3}\s*[-:]\s*\d{2,3}\b/;

const strip = (s) =>
  String(s || "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, " ").trim();

/** Walk the mirrors until one answers with a parseable feed. */
async function timeline(handle) {
  for (const m of MIRRORS) {
    const xml = await get(`https://${m}/${handle}/rss`, { timeout: 18000 });
    if (!xml || !/<rss|<feed/i.test(xml)) continue;
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((b) => ({
      text: strip((b[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1]),
      body: strip((b[1].match(/<description>([\s\S]*?)<\/description>/) || [])[1]).slice(0, 600),
      link: strip((b[1].match(/<link>([\s\S]*?)<\/link>/) || [])[1]),
      date: strip((b[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]),
    })).filter((i) => i.text);
    if (items.length) return { items, mirror: m };
  }
  return null;
}

const handles = Object.entries(registry.clubs)
  .filter(([, c]) => c.twitter)
  .map(([id, c]) => ({
    id,
    handle: String(c.twitter).replace(/^.*\//, "").replace(/^@/, ""),
    name: teams.get(id)?.name_he || c.name_src || id,
  }));

console.log(`clubs with a handle: ${handles.length}`);

const found = [];
const health = [];
let deadMirrors = 0;

for (const club of handles) {
  const tl = await timeline(club.handle);
  if (!tl) { health.push({ club: club.name, handle: club.handle, ok: false }); deadMirrors++; continue; }
  health.push({ club: club.name, handle: club.handle, ok: true, mirror: tl.mirror, tweets: tl.items.length });

  for (const t of tl.items) {
    const hay = (t.text + " " + t.body).toLowerCase();
    const kw = KEYWORDS.filter((k) => hay.includes(k));
    if (!kw.length && !SHAPE.test(t.text)) continue;

    found.push({
      outlet: `x:${club.id}`,
      club: club.name,
      lang: "auto",
      strategy: "twitter",
      title: `${club.name} · ${t.text.slice(0, 90)}`,
      url: t.link,
      published: t.date || null,
      // The tweet travels with the candidate: mirrors are unreliable to fetch
      // twice, and the text is short enough to carry.
      inlineText: `${t.text}\n${t.body}`.slice(0, 1200),
      matchedKeywords: kw,
      matchedClubs: [club.name],
      score: kw.length ? 8 : 5,
    });
  }
}

const existing = read("candidates.json", { candidates: [], health: [] });
const kept = (existing.candidates || []).filter((c) => !String(c.outlet).startsWith("x:"));
fs.writeFileSync(path.join(DATA, "candidates.json"), JSON.stringify({
  ...existing,
  generated: new Date().toISOString(),
  twitterHealth: health,
  candidates: [...kept, ...found].sort((a, b) => b.score - a.score),
}, null, 2));

console.log(`timelines read : ${health.filter((h) => h.ok).length}/${handles.length}`);
console.log(`candidates     : ${found.length}`);
if (deadMirrors) console.log(`unreachable    : ${deadMirrors} (every mirror refused)`);
for (const f of found.slice(0, 10)) console.log(`  · ${f.title.slice(0, 96)}`);
