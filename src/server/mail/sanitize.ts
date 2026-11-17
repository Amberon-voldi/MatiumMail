import "server-only";
import sanitizeHtml from "sanitize-html";

/**
 * Incoming email HTML is hostile input. Defence in depth:
 *
 *   1. sanitizeEmailHtml()  — allowlist sanitiser: no scripts, event handlers,
 *      forms, frames, plugins, meta/base/link, javascript:/vbscript: URLs.
 *   2. emailDocument()      — wraps the result in a full document with a strict
 *      Content-Security-Policy: no scripts at all, and NO remote loads unless
 *      the user opted in (blocks tracking pixels, CSS url() beacons, fonts).
 *   3. The UI renders it in <iframe sandbox> without allow-scripts and without
 *      allow-same-origin, so even a sanitiser bypass can't touch the app.
 *
 * <style> blocks are kept (most HTML email depends on them); with no script
 * execution and no remote loads, CSS cannot exfiltrate anything.
 */

const TAGS = [
  ...sanitizeHtml.defaults.allowedTags,
  "img", "span", "div", "font", "center", "u", "s", "small", "big", "sub", "sup", "hr", "br",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "col", "colgroup", "caption",
  "h1", "h2", "h3", "h4", "h5", "h6", "style", "figure", "figcaption",
];

const COMMON_ATTRS = [
  "style", "class", "id", "align", "valign", "width", "height", "bgcolor", "background", "border",
  "cellpadding", "cellspacing", "dir", "lang", "title", "role",
];

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: TAGS,
  // Required to keep <style>; safe here because nothing in the document can run script.
  allowVulnerableTags: true,
  allowedAttributes: {
    "*": COMMON_ATTRS,
    a: ["href", "name", "target", "rel"],
    img: ["src", "alt", "width", "height", "data-remote-src"],
    font: ["color", "face", "size"],
    td: ["colspan", "rowspan", "nowrap", "scope"],
    th: ["colspan", "rowspan", "nowrap", "scope"],
    table: ["summary"],
    col: ["span"],
    colgroup: ["span"],
    ol: ["start", "type", "reversed"],
    li: ["value"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https", "cid", "data"] },
  allowedSchemesAppliedToAttributes: ["href", "src", "background", "cite"],
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  nonTextTags: ["script", "textarea", "option", "noscript", "title", "iframe", "object", "embed", "template"],
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer nofollow" },
    }),
    img: (tagName, original) => {
      // Only the sanitiser may park URLs; an email can't pre-fill this attribute.
      const attribs = { ...original };
      delete attribs["data-remote-src"];
      const src = attribs.src ?? "";
      // Tracking pixels (1×1 images) are dropped instead of being loaded.
      if (isTrackingPixel(attribs)) return { tagName, attribs: { alt: "", style: "display:none" } };
      // data: is only allowed for raster images (no SVG — it can carry script).
      if (/^data:/i.test(src) && !/^data:image\/(png|jpe?g|gif|webp|bmp);/i.test(src)) {
        return { tagName, attribs: { alt: attribs.alt ?? "" } };
      }
      // Remote images are parked in data-remote-src; emailDocument() points
      // them at the image proxy (or leaves them blocked by the CSP).
      if (/^https?:/i.test(src)) {
        delete attribs.src;
        return { tagName, attribs: { ...attribs, "data-remote-src": src } };
      }
      return { tagName, attribs };
    },
  },
};

function pixels(value: string | undefined): number | null {
  if (value == null) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/i.exec(value);
  return m ? Number(m[1]) : null;
}

/** A 1×1 (or smaller) image: an open-tracking beacon, never content. */
function isTrackingPixel(attribs: Record<string, string>): boolean {
  const style = attribs.style ?? "";
  const w = pixels(attribs.width) ?? pixels(/(?:^|;)\s*width\s*:\s*([^;]+)/i.exec(style)?.[1]);
  const h = pixels(attribs.height) ?? pixels(/(?:^|;)\s*height\s*:\s*([^;]+)/i.exec(style)?.[1]);
  return w !== null && h !== null && w <= 2 && h <= 2;
}

export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, OPTIONS);
}

/** Escape plain text for HTML output. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Plain-text preview from HTML: drops <style>/<script>/<head> contents (which
 * html-to-text conversions often leak as "body,table{...}"), tags and common
 * entities, then collapses whitespace.
 */
export function previewFromHtml(html: string, max = 280): string {
  const text = html
    .replace(/<(style|script|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, max);
}

const REMOTE_REF = /data-remote-src=|background="https?:|url\(\s*(?:&quot;|&#39;|["'])?\s*https?:/i;

/** True when the sanitised HTML references remote images (img, background or CSS url()). */
export function hasBlockedRemoteImages(sanitized: string): boolean {
  return REMOTE_REF.test(sanitized);
}

function decodeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Maps a remote image URL to the same-origin proxy path, or null to keep it blocked. */
export type ImageRewriter = (url: string) => string | null;

const CSS_URL = /url\(\s*(&quot;|&#39;|["'])?\s*(https?:\/\/[^"'()\s]+?)\s*(?:&quot;|&#39;|["'])?\s*\)/gi;

/**
 * Point every remote image reference at the proxy: parked <img> sources,
 * `background` attributes and CSS url() in style attributes and <style> blocks.
 * Proxy paths never contain quotes, parentheses or spaces (see imageProxyUrl).
 */
export function proxyRemoteImages(sanitized: string, rewrite: ImageRewriter): string {
  const attr = (url: string) => {
    const proxied = rewrite(decodeAttr(url));
    return proxied ? proxied.replace(/&/g, "&amp;") : null;
  };
  // <style> contents are raw text (no entity decoding); everything else is markup.
  return sanitized
    .split(/(<style\b[^>]*>[\s\S]*?<\/style>)/i)
    .map((segment, i) => {
      if (i % 2 === 1) {
        return segment.replace(CSS_URL, (m, _q, url: string) => {
          const proxied = rewrite(url);
          return proxied ? `url('${proxied}')` : m;
        });
      }
      return segment
        .replace(/data-remote-src="([^"]*)"/gi, (m, url: string) => {
          const proxied = attr(url);
          return proxied ? `src="${proxied}"` : m;
        })
        .replace(/\bbackground="(https?:[^"]*)"/gi, (m, url: string) => {
          const proxied = attr(url);
          return proxied ? `background="${proxied}"` : m;
        })
        .replace(CSS_URL, (m, _q, url: string) => {
          const proxied = attr(url);
          return proxied ? `url('${proxied}')` : m;
        });
    })
    .join("");
}

const BASE_CSS =
  "html,body{margin:0;padding:0}" +
  'body{padding:12px 14px;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#18181b;background:#fff;overflow-wrap:anywhere;-webkit-text-size-adjust:100%;text-size-adjust:100%}' +
  "img{max-width:100%;height:auto}table{max-width:100%}" +
  "pre{white-space:pre-wrap;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}" +
  "blockquote{margin:0 0 0 .8ex;border-left:2px solid #d4d4d8;padding-left:1ex;color:#52525b}" +
  "a{color:#4318c9}";

/**
 * A complete, self-contained document for <iframe sandbox srcdoc>.
 * With `proxyImages`, remote images load through the same-origin image proxy
 * (the CSP allows 'self' and data: only); without it they stay blocked.
 * Nothing in the document can run script or reach any other server.
 */
export function emailDocument(sanitized: string, opts: { proxyImages?: ImageRewriter } = {}): string {
  const body = opts.proxyImages ? proxyRemoteImages(sanitized, opts.proxyImages) : sanitized;
  const csp = [
    "default-src 'none'",
    opts.proxyImages ? "img-src 'self' data:" : "img-src data:",
    "style-src 'unsafe-inline'",
    "font-src data:",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light"><base target="_blank"><style>${BASE_CSS}</style></head><body>${body}</body></html>`;
}
