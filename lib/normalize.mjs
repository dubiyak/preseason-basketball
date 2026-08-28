/**
 * Shared normalisation. Every stage that turns a written club name into an
 * identity has to agree, or the same club gets two ids and the same game gets
 * counted twice instead of confirmed twice.
 */
import crypto from "node:crypto";

// Turkish and Spanish clubs are routinely written with the current shirt
// sponsor in front. Erokspor arrived as both "Esenler Erokspor" and
// "Safiport Erokspor" from two outlets covering the same tournament.
export const SPONSOR_PREFIXES = [
  "אסיסה", "סורנה", "מונבוס", "קסדמונט", "קוביראן", "MLP", "Glint",
  "Esenler", "Safiport", "Yukatel", "Kosner", "Asisa", "Mozzart Bet",
  "Bahçeşehir Koleji", "Kids&Us", "Monbus", "Casademont", "Coviran",
  "Surne", "Baxi", "Río Breogán", "Dolomiti Energia", "Umana",
];

// Sponsors also appear as suffixes, especially in Serbian and Italian.
export const SPONSOR_SUFFIXES = ["Mozzart Bet", "Beko", "AKTOR", "Playtika", "BC", "KK"];

export function normName(raw) {
  let s = String(raw || "").trim();
  // Only double quotes are gershayim-as-punctuation. A single geresh modifies a
  // Hebrew letter for foreign sounds (ז'לגיריס, קלוז') and must survive.
  s = s.replace(/["״]/g, " ");
  s = s.replace(/\([^)]*\)/g, " ");
  s = s.replace(/\s+/g, " ").trim();

  for (const p of SPONSOR_PREFIXES) {
    if (s.toLowerCase().startsWith(p.toLowerCase() + " ")) s = s.slice(p.length + 1);
  }
  for (const p of SPONSOR_SUFFIXES) {
    if (s.toLowerCase().endsWith(" " + p.toLowerCase())) s = s.slice(0, -(p.length + 1));
  }
  return s.replace(/\s+/g, " ").trim();
}

export const slug = (s) =>
  "t_" + crypto.createHash("sha1").update(normName(s)).digest("hex").slice(0, 8);

/**
 * A loose key for matching the same club written in different scripts or with
 * different diacritics. Not an identity — only a candidate-finder, because
 * "Aris" and "Ares" would collapse together here and must not merge silently.
 */
export function matchKey(raw) {
  return normName(raw)
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

export const COUNTRIES_HE = [
  "ישראל", "ספרד", "איטליה", "טורקיה", "יוון", "גרמניה", "צרפת", "ליטא",
  "לטביה", "סרביה", "קרואטיה", "סלובניה", "בולגריה", "רומניה", "פולין",
  "אנגליה", "מונטנגרו", "בוסניה", "צ'כיה", "סלובקיה", "אוסטריה", "בלגיה",
  "פורטוגל", "אזרבייג'ן", "רוסיה", "קפריסין", "ארה\"ב",
];

export function splitVenue(raw) {
  let s = String(raw || "").trim();
  if (!s || s === "-") return { arena: null, city: null, country: null };

  let arena = null;
  s = s.replace(/\(([^)]*)\)/g, (_, inner) => { arena = inner.trim(); return " "; });
  s = s.replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").replace(/(^,|,$)/g, "").trim();

  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  let country = null;
  if (parts.length && COUNTRIES_HE.includes(parts[parts.length - 1])) country = parts.pop();
  let city = parts.join(", ") || null;
  if (!country && city && COUNTRIES_HE.includes(city)) { country = city; city = null; }
  return { arena, city, country };
}

const STAGE_WORDS = /^(חצי גמר|גמר|רבע גמר|שלב גמר|שלב הבתים)$/;
const DROP_WORDS = /^(מארחת|מארח)$/;

export function splitType(raw) {
  let s = String(raw || "").trim();
  if (!s || s === "-") return { tournament: null, stage: null, flags: [] };

  const flags = [];
  let stage = null;
  s = s.replace(/\(([^)]*)\)/g, (_, inner) => {
    const v = inner.trim();
    if (DROP_WORDS.test(v)) { /* who hosts is never shown */ }
    else if (STAGE_WORDS.test(v)) stage = v;
    else flags.push(v);
    return " ";
  }).replace(/\s+/g, " ").trim();

  if (/^משחק(י)? הכנה$/.test(s) || /^משחק ידידות$/.test(s)) s = "";
  return { tournament: s || null, stage, flags };
}

/**
 * Identity of a game: the date plus the unordered pair of clubs. Unordered
 * because home and away are often unknown and always irrelevant to whether two
 * reports describe the same fixture.
 */
/**
 * One spelling for a tip-off, so two sources that agree are not read as two.
 *
 * legabasket writes "ore 17.30" and everybody else writes 17:30, and the build
 * compared the strings: 39 of the 60 recorded conflicts in the first run that
 * carried the Italian calendar were a full stop against a colon, on games where
 * the sources agreed exactly. Recorded as disagreements they bury the ones that
 * are real — 14 games where two sources are genuinely an hour apart.
 *
 * Normalised here rather than at extraction because extraction is cached for
 * ever, so this reaches the Italian rows already read without re-reading them.
 */
export function normTime(raw) {
  const m = String(raw || "").trim().match(/^(\d{1,2})[.:h](\d{2})$/i);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

export function gameKey({ date, time, teamIds, label, tournament }) {
  const ids = [...(teamIds || [])].filter(Boolean).sort();
  if (date && ids.length === 2) return `pair:${date}|${ids.join("|")}`;
  // Without a date or a second club there is nothing to match on, so the entry
  // keeps its own identity rather than merging with something it is not. Time
  // belongs in this key: a tournament's two undrawn finals share a date, a
  // venue and a single known club, and differ only by tip-off.
  // The label is only an identity when there is no real date. Two outlets
  // writing "5 Eylül" and "September 5" for one undrawn fixture agree on
  // everything that matters, and must not become two games over wording.
  const when = date ? `${date}|${time || ""}` : `|${time || ""}|${label || ""}`;
  return `solo:${ids.join("|")}|${when}|${tournament || ""}`;
}

export const gameId = (key) =>
  "g_" + crypto.createHash("sha1").update(key).digest("hex").slice(0, 10);
