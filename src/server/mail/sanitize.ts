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
    img: (tagName, attribs) => {
      const src = attribs.src ?? "";
      // data: is only allowed for raster images (no SVG — it can carry script).
      if (/^data:/i.test(src) && !/^data:image\/(png|jpe?g|gif|webp|bmp);/i.test(src)) {
        return { tagName, attribs: { alt: attribs.alt ?? "" } };
      }
      // Remote images are parked in data-remote-src; the CSP blocks them anyway.
      if (/^https?:/i.test(src)) {
        const rest = { ...attribs };
        delete rest.src;
        return { tagName, attribs: { ...rest, "data-remote-src": src } };
      }
      return { tagName, attribs };
    },
  },
};

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

/** True when the sanitised HTML references remote images the user hasn't loaded. */
export function hasBlockedRemoteImages(sanitized: string): boolean {
  return /data-remote-src=/i.test(sanitized);
}

/**
 * A complete, self-contained document for <iframe sandbox srcdoc>.
 * With allowRemoteImages, parked images are restored and https images are
 * permitted by the CSP; everything else stays blocked.
 */
export function emailDocument(sanitized: string, opts: { allowRemoteImages?: boolean } = {}): string {
  let body = sanitized;
  let imgSrc = "data: cid:";
  if (opts.allowRemoteImages) {
    body = body.replace(/data-remote-src="([^"]*)"/gi, (_m, url: string) => `src="${url}"`);
    imgSrc += " https: http:";
  }
  const csp = [
    "default-src 'none'",
    `img-src ${imgSrc}`,
    "style-src 'unsafe-inline'",
    "font-src data:",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><base target="_blank"><style>html,body{margin:0;padding:0}body{padding:16px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#111;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}</style></head><body>${body}</body></html>`;
}
