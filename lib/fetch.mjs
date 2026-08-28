/**
 * One place that talks to the outside world.
 *
 * The polite identifying User-Agent this started with is refused outright by
 * some club sites — hapoelbc.com answers it with 403 and a browser string with
 * 200 — and those are exactly the sites that publish the fixture detail news
 * reports leave out. So requests look like a browser.
 *
 * The trade is worth stating plainly: this reads public fixture pages a few
 * hundred times a day, caches every article so nothing is fetched twice, and
 * takes nothing that is not on the page for any visitor.
 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export async function get(url, { timeout = 20000, accept = "*/*" } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": UA,
        Accept: accept,
        "Accept-Language": "en,he;q=0.9,es;q=0.8,it;q=0.8,el;q=0.7,tr;q=0.7",
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Keep the destination of a link next to the words that carry it.
 *
 * A reader sees "boxscore" and can click it; the model was handed the word with
 * nothing behind it, because every tag was stripped before it read the page. So
 * statsUrl, reportUrl and broadcastUrl could never be filled by anything but
 * invention, which the prompt forbids — 350 games, not one link between them,
 * and the card layer that renders them sat dark for weeks looking like a source
 * problem.
 *
 * Rendered as "text [url]" so a URL stays attached to the row it belongs to,
 * which is what lets a fixture table give one boxscore per line.
 *
 * Bounded, because a page is mostly navigation: absolute http(s) only, deduped,
 * skipping links whose own text is empty or already a URL, and capped. The cap
 * matters more than it looks — the ABA calendar alone carries a hundred links,
 * and the article budget is measured in characters.
 */
const MAX_LINKS = 80;
const MAX_URL = 200;

function inlineLinks(html, base) {
  const seen = new Set();
  return html.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (whole, href, inner) => {
      if (seen.size >= MAX_LINKS) return whole;
      const text = inner.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      if (!text || /^https?:/i.test(text)) return whole;
      let url;
      try { url = new URL(href, base || undefined).href; } catch { return whole; }
      if (!/^https?:/i.test(url) || url.length > MAX_URL) return whole;
      // The same link twice is the same fact twice, and the second costs as
      // much as the first.
      if (seen.has(url)) return whole;
      seen.add(url);
      return `${whole} [${url}] `;
    });
}

/**
 * Strip a page down to the text a reader would see.
 *
 * With { links: true } the text a reader would see includes where each link
 * goes. `base` resolves relative hrefs, which is most of them on a club site.
 */
export function toText(html, limit = 14000, { links = false, base = null } = {}) {
  // Throw away the furniture BEFORE inlining links, not after. A page is mostly
  // navigation, and on the ABA calendar the menu alone holds more anchors than
  // the whole link budget — spent there first, the cap was exhausted before the
  // parser reached a single fixture row, and the text came back byte for byte
  // identical to the version with no links at all.
  // Normalise line endings first. Everything downstream collapses runs of "%B%n",
  // and a stray "%B%r" between them defeats it: this page came through with 2,023
  // blank lines out of 2,826, most of the payload being carriage returns.
  const chrome = String(html || "").replace(/\r\n?/g, "\n")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|header|footer|aside|form|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  return (links ? inlineLinks(chrome, base) : chrome)
    // The OPENING tag, not the closing one. presaison.lnb.info writes
    // <td>Levallois<td>Rouen</td> — the home cell is never closed, so a rule
    // firing on </td> yielded "Levallois Rouen" as ONE field with no delimiter
    // left to split on. "Avenir Basket Berck Rang du Fliers" against
    // "Châlons-Reims" cannot be cut apart by any reader, model included: two
    // facts fused into one string fail exactly the way one fact asked for as
    // two optional fields does, and it costs the whole French calendar.
    //
    // Firing on BOTH tags looks safer and is worse. Every well-formed cell
    // then emits two bars, "a |  | b", which is character for character what
    // an empty cell looks like — and collapsing the runs to tell them apart
    // deletes the empty cell instead. acb.com's date column IS empty in the
    // markup, so its rows lost a field and every column after it shifted left
    // under a five-column header. A bar per cell opening counts every cell
    // exactly once, closed or not, empty or not.
    .replace(/<(td|th)\b[^>]*>/gi, " | ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d|section)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n[ \n]*/g, "\n")
    .trim()
    .slice(0, limit);
}

/**
 * Recover the fixtures a JavaScript page carries but never prints.
 *
 * acb.com renders its whole preseason table server-side EXCEPT the date
 * column, which ships as <span class="_skeleton_" data-empty="true"> and is
 * filled in by the client. The page fetches at 261KB, reads as a clean fixture
 * table, and every row is undated — the one field that makes a fixture a
 * fixture. No better parsing of the visible HTML reaches it, because the dates
 * are not in the HTML: they sit in the framework payload beside the teams, the
 * venue, the tournament and the score.
 *
 * This takes them without knowing anything about acb. It undoes the layers of
 * backslash-escaping a payload arrives in, pulls every balanced {...} holding a
 * timestamp, and keeps what JSON.parse accepts. Parsing IS the filter: a run of
 * characters that merely looks like an object will not parse, and prose never
 * does. Nothing here names a site, a framework or a field.
 */
const STAMP = /20\d\d-\d\d-\d\d[T ]\d{2}:\d{2}/;
const SCALAR = new Set(["string", "number", "boolean"]);
const MAX_ROWS = 300;

function balanced(s, at) {
  let depth = 0, start = -1;
  for (let k = at; k >= 0 && at - k < 6000; k--) {
    if (s[k] === "}") depth++;
    else if (s[k] === "{") { if (!depth) { start = k; break; } depth--; }
  }
  if (start < 0) return null;
  depth = 0;
  for (let k = start; k < s.length && k - start < 12000; k++) {
    if (s[k] === "{") depth++;
    else if (s[k] === "}") { depth--; if (!depth) return s.slice(start, k + 1); }
  }
  return null;
}

/**
 * One row per fixture, even when the payload files the same fixture four times.
 *
 * acb stores each game once per club section, and in two of its 54 games those
 * copies disagree about which club is at home while keeping the score in one
 * order — "Leyma 82 Monbus 89" against "Monbus 82 Leyma 89" for the game the
 * league's own table prints as Monbus 82-89 Leyma. Handing both to the
 * extractor is how a reversed result gets published, and the last one was
 * caught by eye rather than by a test. So copies collapse on their values
 * (booleans excluded: the bogus pair differs only by an internal display
 * flag), and the ordering that survives is the one the page's own text shows.
 */
export function hydrate(html, visible = "") {
  let s = String(html || "");
  if (!STAMP.test(s)) return [];
  for (let k = 0; k < 3 && s.includes('\\"'); k++)
    s = s.replace(/\\"/g, '"').replace(/\\/g, "\\");

  const seen = new Map();
  const re = new RegExp(STAMP.source, "g");
  let m;
  while ((m = re.exec(s)) && seen.size < MAX_ROWS) {
    const chunk = balanced(s, m.index);
    if (!chunk) continue;
    let o;
    try { o = JSON.parse(chunk); } catch { continue; }
    if (!o || typeof o !== "object" || Array.isArray(o)) continue;

    const flat = Object.entries(o).filter(
      ([, v]) => v !== null && v !== "" && SCALAR.has(typeof v) && String(v).length <= 300);
    if (flat.length < 3) continue;
    if (!flat.some(([, v]) => STAMP.test(String(v)))) continue;

    const words = flat.filter(([, v]) => typeof v === "string").map(([, v]) => String(v));
    const key = [...words].sort().join("\u0001");
    const prev = seen.get(key);
    if (!prev || agreesWithPage(words, visible) > agreesWithPage(prev.words, visible))
      seen.set(key, { words, line: flat.map(([k, v]) => `${k}=${v}`).join(" | ") });
  }
  return [...seen.values()].map((r) => r.line);
}

// How much of an ordering the page itself shows, counted over consecutive
// pairs. The visible table prints "Monbus Obradoiro 82 - 89 Leyma Coruña", so
// the copy naming Monbus first scores and the copy naming Leyma first does not.
function agreesWithPage(words, visible) {
  if (!visible) return 0;
  let score = 0;
  for (let i = 1; i < words.length; i++) {
    const a = visible.indexOf(words[i - 1]), b = visible.indexOf(words[i]);
    if (a >= 0 && b >= 0 && a < b) score++;
  }
  return score;
}

/**
 * The text of a page, including whatever it only carries in a payload.
 *
 * A page that prints its own dates keeps its text and gains the payload as
 * corroboration — both copies are dated, so they land on one game key. A
 * skeleton page is REPLACED by its payload past the heading, because keeping
 * the date-less table beside a dated one files every fixture twice over:
 * gameKey pairs two records only on a date, so the undated copy never merges
 * away and every ACB game would arrive as a game and a ghost.
 */
const DATED_ENOUGH = 5;
const ROWS_ENOUGH = 5;
const CELLS_ENOUGH = 20;
export const DATE_SHAPE = /\b(0?[1-9]|[12]\d|3[01])[.\/-](0?[1-9]|1[0-2])(?:[.\/-]\d{2,4})?\b/g;

/**
 * Replacing the visible text is for skeletons only, and the test has to be
 * narrow or it eats ordinary articles.
 *
 * Nearly every news page carries a datePublished in a JSON-LD block, so
 * "the payload holds a timestamp" is true almost everywhere. And a Spanish or
 * Italian article writes its dates in words, so "the visible text has no
 * numeric dates" is true there too. Those two conditions alone would have
 * thrown away the body of every foreign-language article in the collection
 * and kept its publication date.
 *
 * What a skeleton has that an article does not is a table: acb's page carries
 * 432 cell boundaries and 81 payload rows, the CSKA article carries one and
 * none. Measured on both before this was allowed to run.
 */
function isSkeletonTable(visible, rows) {
  return rows.length >= ROWS_ENOUGH &&
         (visible.match(DATE_SHAPE) || []).length < DATED_ENOUGH &&
         (visible.match(/\|/g) || []).length >= CELLS_ENOUGH;
}

export function pageText(html, limit = 20000, { links = false, base = null } = {}) {
  const visible = toText(html, limit, { links, base });
  const rows = hydrate(html, visible);
  if (!rows.length) return visible;
  const head = isSkeletonTable(visible, rows) ? visible.slice(0, 600) : visible;
  return (head + "\n-- fixtures embedded in the page --\n" + rows.join("\n")).slice(0, limit);
}
