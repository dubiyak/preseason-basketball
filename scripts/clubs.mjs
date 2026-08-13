/**
 * Layer 2 seed: who the clubs are and where they publish.
 *
 * The collector reads 25 news outlets and no club sites at all, which is why
 * tournament draws were missing. A club's own site prints the actual fixture —
 * hapoelbc.com lists "12.09.26 19:00, Maxima Roma, Cagliari" where every news
 * report said only "Bayern / Villeurbanne / Roma".
 *
 * The EuroLeague API hands over website, Twitter handle, city, country and
 * home arena for every EuroLeague and EuroCup club, structured and free, so
 * none of this is typed by hand.
 */
import fs from "node:fs";
import path from "node:path";
import { matchKey } from "../lib/normalize.mjs";
import { resolveWithModel, newClub } from "./resolve.mjs";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const API = "https://api-live.euroleague.net/v2/competitions";
const SEASONS = [
  { comp: "E", season: "E2026", competition: "euroleague" },
  { comp: "U", season: "U2026", competition: "eurocup" },
];

const read = (f, fb) =>
  fs.existsSync(path.join(DATA, f)) ? JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")) : fb;

const teams = read("teams.json", { teams: [] }).teams;
const registry = read("registry.json", { clubs: {} });
const aliases = read("aliases.json", { map: {} });

// Country names arrive from the API in English.
const COUNTRY_HE = {
  Turkiye: "טורקיה", Spain: "ספרד", Italy: "איטליה", Greece: "יוון",
  Germany: "גרמניה", France: "צרפת", Israel: "ישראל", Lithuania: "ליטא",
  Serbia: "סרביה", Slovenia: "סלובניה", Croatia: "קרואטיה", Latvia: "לטביה",
  Monaco: "מונאקו", "United Arab Emirates": "איחוד האמירויות", Poland: "פולין",
  Romania: "רומניה", Bulgaria: "בולגריה", Montenegro: "מונטנגרו",
  "United Kingdom": "אנגליה", Bosnia: "בוסניה", Portugal: "פורטוגל",
  Czechia: "צ'כיה", Belgium: "בלגיה", Hungary: "הונגריה",
};

// Registry lookup by every spelling we already know for a club.
const byKey = new Map();
for (const t of teams) {
  for (const n of [t.name_he, t.name_src, ...(t.aliases || [])]) {
    const k = matchKey(n);
    if (k && !byKey.has(k)) byKey.set(k, t.id);
  }
}
for (const [name, id] of Object.entries(aliases.map || {})) {
  const k = matchKey(name);
  if (k && !byKey.has(k)) byKey.set(k, id);
}

const titleCase = (s) =>
  String(s || "").toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());

let matched = 0, unmatched = [];
const pending = [];
const seen = new Set();

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
const MODELS = (process.env.GEMINI_MODELS ||
  "gemini-flash-latest,gemini-flash-lite-latest,gemini-3-flash-preview,gemini-3.1-flash-lite-preview")
  .split(",").map((s) => s.trim());

for (const { comp, season, competition } of SEASONS) {
  const res = await fetch(`${API}/${comp}/seasons/${season}/clubs`);
  if (!res.ok) { console.log(`! ${comp}: HTTP ${res.status}`); continue; }
  const clubs = (await res.json()).data || [];
  console.log(`${competition}: ${clubs.length} clubs`);

  for (const c of clubs) {
    // Try every name the API gives before deciding a club is unknown.
    const names = [c.name, c.abbreviatedName, c.editorialName, c.clubPermanentName, c.clubPermanentAlias]
      .filter(Boolean);
    const id = names.map((n) => byKey.get(matchKey(n))).find(Boolean);

    const facts = {
      name_src: c.name || null,
      country: COUNTRY_HE[c.country?.name] || c.country?.name || null,
      city: titleCase(c.city),
      website: c.website || null,
      twitter: c.twitterAccount || null,
      venueCode: c.venueCode || null,
      competitions: [competition],
      elCode: c.code,
    };

    if (!id) { pending.push({ name: c.name, facts }); continue; }
    apply(id, facts);
  }
}

/**
 * The registry is in Hebrew and the API is in Latin, so a character-based
 * match finds only the handful of clubs the seed happened to store in Latin.
 * Same resolver the fixture pipeline uses, same reason: only a model sees
 * that "Zalgiris Kaunas" and "ז'לגיריס קובנה" are one club.
 */
if (pending.length) {
  const key = loadKey();
  if (!key) {
    console.log(`\n${pending.length} clubs unmatched and no key — rerun with GEMINI_API_KEY`);
  } else {
    const { data } = await resolveWithModel(pending.map((p) => p.name), teams,
      { key, models: MODELS, log: (m) => console.log(m) });
    const byName = new Map(pending.map((p) => [p.name, p.facts]));
    for (const r of data?.resolved || []) {
      const facts = byName.get(r.name);
      if (!facts) continue;
      if (r.matchesExisting && teams.some((t) => t.id === r.matchesExisting)) {
        aliases.map[r.name] = r.matchesExisting;
        apply(r.matchesExisting, facts);
        byName.delete(r.name);
      } else if (r.confident && /[֐-׿]/.test(r.hebrewName || "")) {
        // A club in these competitions that we have no fixtures for at all is
        // exactly the one worth polling hardest, so it joins the registry.
        const c = newClub(r.name, r.hebrewName, facts.country);
        aliases.map[r.name] = c.id;
        apply(c.id, { ...facts, name_he: r.hebrewName });
        byName.delete(r.name);
      }
    }
    unmatched = [...byName.keys()];
    fs.writeFileSync(path.join(DATA, "aliases.json"),
      JSON.stringify({ ...aliases, map: aliases.map }, null, 2));
  }
}

function apply(id, facts) {
    matched++;
    seen.add(id);

    const prev = registry.clubs[id] || {};
    registry.clubs[id] = {
      ...prev,
      ...facts,
      // Never overwrite a Hebrew name that already exists — a club's displayed
      // identity must not change because an API spelled it differently.
      name_he: prev.name_he || facts.name_he || undefined,
      competitions: [...new Set([...(prev.competitions || []), ...(facts.competitions || [])])],
      // newsUrl is discovered separately and is expensive to find; keep it.
      newsUrl: prev.newsUrl ?? null,
      homeArena: prev.homeArena ?? null,
    };
    for (const k of Object.keys(registry.clubs[id])) {
      if (registry.clubs[id][k] === undefined) delete registry.clubs[id][k];
    }
}

fs.writeFileSync(path.join(DATA, "registry.json"), JSON.stringify(registry, null, 2));

const withSite = Object.values(registry.clubs).filter((c) => c.website).length;
const withTwitter = Object.values(registry.clubs).filter((c) => c.twitter).length;
console.log(`\nmatched to registry : ${matched}`);
console.log(`with a website      : ${withSite}`);
console.log(`with a twitter      : ${withTwitter}`);
if (unmatched.length) {
  console.log(`unmatched (${unmatched.length}) — no registry entry under any API spelling:`);
  for (const u of unmatched) console.log(`  · ${u}`);
}
