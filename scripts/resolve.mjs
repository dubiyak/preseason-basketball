/**
 * Resolve club names as written into registry ids.
 *
 * Names arrive in whatever script the outlet writes in: Ηρακλής, Άρης,
 * Anadolu Efes, Партизан, הפועל תל אביב. Three passes, cheapest first:
 *
 *   1. A learned alias — already resolved once, remembered forever.
 *   2. A normalised or loose-key match against the registry.
 *   3. The model, asked to pick from a shortlist or say it is a new club.
 *
 * Every answer is written to data/aliases.json, so a name is resolved once in
 * the lifetime of the project. That is what keeps this inside a 20-request
 * daily quota, and it is also what keeps a club's identity stable: a mapping
 * recomputed each run is a mapping that can change each run.
 */
import fs from "node:fs";
import path from "node:path";
import { normName, matchKey, slug } from "../lib/normalize.mjs";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const ALIASES = path.join(DATA, "aliases.json");

export function loadAliases() {
  return fs.existsSync(ALIASES)
    ? JSON.parse(fs.readFileSync(ALIASES, "utf8"))
    : { _doc: "Club name as written -> registry id. Written once per name, kept forever.", map: {} };
}
export function saveAliases(a) {
  fs.writeFileSync(ALIASES, JSON.stringify(a, null, 2));
}

/** Build lookup tables over the current registry. */
export function buildIndex(teams) {
  const byMatch = new Map();
  for (const t of teams) {
    for (const n of [t.name_he, t.name_src, ...(t.aliases || [])]) {
      if (!n) continue;
      const k = matchKey(n);
      if (k && !byMatch.has(k)) byMatch.set(k, t.id);
    }
  }
  return { byMatch, byId: new Map(teams.map((t) => [t.id, t])) };
}

/** Passes 1 and 2. Returns null when the model is needed. */
export function resolveLocal(name, index, aliases) {
  const raw = String(name || "").trim();
  if (!raw) return null;
  if (aliases.map[raw]) return aliases.map[raw];

  const k = matchKey(raw);
  if (!k) return null;
  if (aliases.map[k]) return aliases.map[k];
  if (index.byMatch.has(k)) return index.byMatch.get(k);
  return null;
}

/* ---------- pass 3: ask the model, in one batch ---------- */

const SCHEMA = {
  type: "object",
  properties: {
    resolved: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "the input name, copied back exactly" },
          matchesExisting: { type: "string", description: "the id of the existing club this is the same club as, or empty if none of them is" },
          hebrewName: { type: "string", description: "the club's usual Hebrew name, for a new club" },
          country: { type: "string", description: "country in Hebrew" },
          confident: { type: "boolean", description: "false if unsure whether it matches an existing club" },
        },
        required: ["name", "matchesExisting", "hebrewName", "confident"],
      },
    },
  },
  required: ["resolved"],
};

const PROMPT = `You match European basketball club names to a registry.

You are given the full registry, then a list of names as written by news outlets. For each name, decide whether it is the SAME CLUB as a registry entry.

The same club is written differently across scripts, languages and seasons, and you must see through all of it: "Ηρακλής", "Iraklis" and "הרקליס" are one club; "Erokspor" and "ארוקספור" are one club; "Esenler Erokspor" and "Safiport Erokspor" differ only by shirt sponsor; "Partizan Mozzart Bet" is Partizan Belgrade. A Hebrew registry name and a Latin or Greek input share no characters — compare how they SOUND, not how they look.

Rules:
- If it is the same club as a registry entry, put that entry's id in matchesExisting.
- If no registry entry is that club, leave matchesExisting empty and give the club's usual Hebrew name in hebrewName. Use the Hebrew form a sports outlet would print, not a letter-by-letter transliteration.
- The names you are given may contain the SAME club twice, written two ways. When two inputs are one club, give them the IDENTICAL hebrewName — that is what merges them. Never invent two spellings for one club.
- hebrewName must be written in Hebrew letters. Never return a Latin, Greek or Cyrillic name in that field.
- Different clubs from the same city are NOT the same club. Aris Thessaloniki and PAOK Thessaloniki are different. A club's youth or second team is not the first team.
- Set confident=false if you are unsure. A wrong match merges two clubs permanently, which is worse than leaving one unresolved.
- Always give a Hebrew name, even when matchesExisting is set.`;

export async function resolveWithModel(names, teams, { key, models, log = () => {} }) {
  if (!names.length || !key) return {};

  /**
   * The whole registry, every time — not a shortlist.
   *
   * Shortlisting by shared characters is script-blind, and this data is not:
   * "ארוקספור" and "Erokspor" share no character at all, so the correct
   * candidate was never shown and the model dutifully created a second club
   * for the same team. A few hundred clubs is a small prompt; a split identity
   * is a permanent duplicate.
   */
  const roster = teams
    .map((t) => {
      const extra = [t.name_src, ...(t.aliases || [])].filter(Boolean).filter((n) => n !== t.name_he);
      return `${t.id} = ${t.name_he}${extra.length ? ` [${[...new Set(extra)].slice(0, 6).join(" / ")}]` : ""}`;
    })
    .join("\n");

  const body =
    `REGISTRY (id = Hebrew name [other spellings already known]):\n${roster}\n\n` +
    `NAMES TO RESOLVE:\n` +
    names.map((n, i) => `NAME ${i}: ${n}`).join("\n");

  for (const model of models) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
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
    if (res.status === 429) { log(`  resolver: ${model} out of quota`); continue; }
    if (!res.ok) { log(`  resolver: ${model} ${res.status}`); continue; }

    const j = await res.json();
    const raw = j?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) continue;
    try { return { data: JSON.parse(raw), model }; } catch { continue; }
  }
  return {};
}

/** Create a registry entry for a club the resolver says is genuinely new. */
export function newClub(name, hebrewName, country) {
  const he = hebrewName || normName(name);
  return {
    id: slug(he),
    name_he: he,
    name_src: normName(name),
    aliases: [name],
    competitions: [],
    country: country || null,
    homeArena: null,
    website: null,
    newsUrl: null,
  };
}
