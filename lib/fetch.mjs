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

/** Strip a page down to the text a reader would see. */
export function toText(html, limit = 14000) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|header|footer|aside|form|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
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
