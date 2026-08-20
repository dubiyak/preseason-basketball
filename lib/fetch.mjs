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
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d|section)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n[ \n]*/g, "\n")
    .trim()
    .slice(0, limit);
}
