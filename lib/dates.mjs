/**
 * Resolve a written date to a real day.
 *
 * The extractor was told to emit a date only when it "resolves to a real day",
 * and it read a range as unresolvable — so "12 e 13 settembre", "26 de
 * septiembre", "10-11 września" and "11-13 Eylül" all arrived as text with no
 * date, and the games showed as undated. They are not undated: a two-day
 * tournament starts on the first of the two.
 *
 * Deterministic on purpose. This runs over data already collected, costs no
 * quota, and gives the same answer every time.
 */

// Month names in every language the sources publish in, longest first so
// "settembre" is tried before "set".
const MONTHS = {
  1: ["january", "gennaio", "enero", "janvier", "januar", "ocak", "ιανουαρίου", "ianuarie", "sausio", "janvāra", "styczeń", "stycznia", "januar", "siječnja", "ינואר"],
  2: ["february", "febbraio", "febrero", "février", "februar", "şubat", "φεβρουαρίου", "februarie", "vasario", "februāra", "luty", "lutego", "veljače", "פברואר"],
  3: ["march", "marzo", "mars", "märz", "mart", "μαρτίου", "martie", "kovo", "marta", "marzec", "marca", "ožujka", "מרץ"],
  4: ["april", "aprile", "abril", "avril", "nisan", "απριλίου", "aprilie", "balandžio", "aprīļa", "kwiecień", "kwietnia", "travnja", "אפריל"],
  5: ["may", "maggio", "mayo", "mai", "mayıs", "μαΐου", "mai", "gegužės", "maija", "maj", "maja", "svibnja", "מאי"],
  6: ["june", "giugno", "junio", "juin", "juni", "haziran", "ιουνίου", "iunie", "birželio", "jūnija", "czerwiec", "czerwca", "lipnja", "יוני"],
  7: ["july", "luglio", "julio", "juillet", "juli", "temmuz", "ιουλίου", "iulie", "liepos", "jūlija", "lipiec", "lipca", "srpnja", "יולי"],
  8: ["august", "agosto", "août", "ağustos", "αυγούστου", "augustie", "rugpjūčio", "augusta", "sierpień", "sierpnia", "kolovoza", "avgust", "אוגוסט"],
  9: ["september", "settembre", "septiembre", "septembre", "eylül", "σεπτεμβρίου", "septembrie", "rugsėjo", "septembra", "wrzesień", "września", "rujna", "septembar", "ספטמבר"],
  10: ["october", "ottobre", "octubre", "octobre", "oktober", "ekim", "οκτωβρίου", "octombrie", "spalio", "oktobra", "październik", "października", "listopada", "oktobar", "אוקטובר"],
  11: ["november", "novembre", "noviembre", "kasım", "νοεμβρίου", "noiembrie", "lapkričio", "novembra", "listopad", "studenoga", "novembar", "נובמבר"],
  12: ["december", "dicembre", "diciembre", "décembre", "dezember", "aralık", "δεκεμβρίου", "decembrie", "gruodžio", "decembra", "grudzień", "grudnia", "prosinca", "decembar", "דצמבר"],
};

const MONTH_LOOKUP = Object.entries(MONTHS)
  .flatMap(([n, names]) => names.map((name) => [name, Number(n)]))
  .sort((a, b) => b[0].length - a[0].length);

const pad = (n) => String(n).padStart(2, "0");

/**
 * @param {string} text  the date as written
 * @param {string} seasonStart  ISO date the season's window opens
 * @returns {string|null} ISO yyyy-mm-dd, taking the FIRST day of any range
 */
export function resolveDate(text, seasonStart = "2026-06-01") {
  const s = String(text || "").toLowerCase().trim();
  if (!s) return null;

  const year = Number(seasonStart.slice(0, 4));
  const seasonEnd = `${year + 1}-07-31`;

  const inWindow = (iso) => iso >= seasonStart && iso <= seasonEnd;

  // Already numeric: dd.mm.yyyy, dd/mm/yy, yyyy-mm-dd
  const iso = s.match(/\b(20\d\d)-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    const v = `${iso[1]}-${pad(iso[2])}-${pad(iso[3])}`;
    return inWindow(v) ? v : null;
  }
  const dmy = s.match(/\b(\d{1,2})[.\/-](\d{1,2})[.\/-](20\d\d|\d{2})\b/);
  if (dmy) {
    const y = dmy[3].length === 2 ? 2000 + Number(dmy[3]) : Number(dmy[3]);
    const v = `${y}-${pad(dmy[2])}-${pad(dmy[1])}`;
    return inWindow(v) ? v : null;
  }

  // Bare day.month, the usual Hebrew and Serbian shorthand: "3.9", "18-19.9".
  // Only trusted when the month lands inside the season, so "71:92" and other
  // numeric noise cannot be read as a date.
  const dm = s.match(/\b(\d{1,2})(?:\s*[-–]\s*\d{1,2})?[.\/](\d{1,2})\b(?![.\/]?\d)/);
  if (dm) {
    const day = Number(dm[1]);
    const mon = Number(dm[2]);
    if (day >= 1 && day <= 31 && mon >= 1 && mon <= 12) {
      const y = mon >= 8 ? year : year + 1;
      const v = `${y}-${pad(mon)}-${pad(day)}`;
      if (inWindow(v)) return v;
    }
  }

  // A named month somewhere in the string.
  const hit = MONTH_LOOKUP.find(([name]) => s.includes(name));
  if (!hit) return null;
  const month = hit[1];

  // Every day-number before the month word. "12 e 13 settembre" -> 12;
  // "weekend del 5-6 settembre" -> 5; "11-13 Eylül" -> 11.
  const before = s.slice(0, s.indexOf(hit[0]));
  let days = [...before.matchAll(/\b(\d{1,2})\b/g)].map((m) => Number(m[1]));
  // Some languages put the day after: "settembre 12", "Eylül 11-13".
  if (!days.length) {
    const after = s.slice(s.indexOf(hit[0]) + hit[0].length);
    days = [...after.matchAll(/\b(\d{1,2})\b/g)].map((m) => Number(m[1]));
  }
  days = days.filter((d) => d >= 1 && d <= 31);
  if (!days.length) return null;

  // The first day of the range is when the fixture list starts.
  const day = Math.min(...days);

  // The season spans two calendar years: months before August belong to the
  // later one.
  const y = month >= 8 ? year : year + 1;
  const v = `${y}-${pad(month)}-${pad(day)}`;
  return inWindow(v) ? v : null;
}

/** True when the text names a period rather than a day ("mid-September"). */
export function isVague(text) {
  return /תחילת|אמצע|סוף|early |mid[- ]|late |inizio|metà|fine |primeros|mediados|finales|début|mi-|fin |anfang|mitte|ende |טרם|not final|לא סופי|לא צוין|tba|tbd/i
    .test(String(text || ""));
}
