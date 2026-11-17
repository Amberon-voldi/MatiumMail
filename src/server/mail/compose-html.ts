import "server-only";
import sanitizeHtml from "sanitize-html";
import { escapeHtml, sanitizeEmailHtml } from "./sanitize";

/**
 * HTML for outgoing mail: what the user typed in the composer (formatting,
 * links, pasted images) and quotes of the message being answered.
 */

const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]{3,20})$/i;
const LENGTH = /^\d+(\.\d+)?(px|pt|em|rem|%)$/;

const OUTGOING: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "div", "br", "span", "b", "strong", "i", "em", "u", "s", "strike", "del", "a", "ul", "ol", "li",
    "blockquote", "h1", "h2", "h3", "pre", "code", "hr", "font", "sub", "sup", "img",
    "table", "thead", "tbody", "tr", "td", "th",
  ],
  allowedAttributes: {
    "*": ["style", "dir", "align"],
    a: ["href", "title"],
    img: ["src", "alt", "width", "height"],
    font: ["color", "face", "size"],
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan"],
  },
  allowedStyles: {
    "*": {
      color: [COLOR],
      "background-color": [COLOR],
      "text-align": [/^(left|right|center|justify)$/],
      "font-weight": [/^(bold|normal|[1-9]00)$/],
      "font-style": [/^(italic|normal)$/],
      "text-decoration": [/^[a-z\s-]{1,40}$/],
      "font-size": [LENGTH, /^(x-small|small|medium|large|x-large)$/],
      "font-family": [/^[\w\s,"'-]{1,100}$/],
      "margin-left": [LENGTH],
      "padding-left": [LENGTH],
    },
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["https", "data", "cid"] },
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  transformTags: {
    a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer" } }),
    img: (tagName, attribs) => {
      const src = attribs.src ?? "";
      const ok = /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(src) || /^(https|cid):/i.test(src);
      return { tagName, attribs: ok ? attribs : { alt: attribs.alt ?? "" } };
    },
  },
};

/** The composer's HTML, reduced to formatting that is safe and renders in every mail client. */
export function sanitizeOutgoingHtml(html: string): string {
  return sanitizeHtml(html, OUTGOING).trim();
}

/** A received message's HTML, safe to quote or forward: no <style> blocks, remote images left as they were. */
export function quotableHtml(html: string): string {
  return sanitizeEmailHtml(html)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/data-remote-src="([^"]*)"/gi, 'src="$1"');
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };

/** Plain-text alternative of an HTML body (for clients that don't show HTML). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      return !label || label === href || href.startsWith("mailto:") ? label || href : `${label} (${href})`;
    })
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|tr|blockquote|pre|ul|ol|table)>/gi, "\n")
    .replace(/<hr\b[^>]*>/gi, "\n----------\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#?\w+);/g, (m, name: string) =>
      ENTITIES[name] ?? (/^#\d+$/.test(name) ? String.fromCodePoint(Number(name.slice(1))) : m),
    )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** "> "-prefixed plain-text quote. */
export function quoteText(text: string): string {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => (line.startsWith(">") ? `>${line}` : `> ${line}`))
    .join("\n");
}

/** The usual reply layout: label line, then the original in a left-bordered blockquote. */
export function replyQuoteHtml(label: string, original: string): string {
  return (
    `<br><div class="mm_quote"><div>${escapeHtml(label)}</div>` +
    `<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${original}</blockquote></div>`
  );
}

/** Gmail-style forwarded-message header followed by the original. */
export function forwardQuoteHtml(fields: Array<[string, string]>, original: string): string {
  const lines = fields
    .filter(([, v]) => v)
    .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(v)}`)
    .join("<br>");
  return `<br><div class="mm_forward">---------- Forwarded message ---------<br>${lines}<br><br>${original}</div>`;
}

export function forwardQuoteText(fields: Array<[string, string]>, original: string): string {
  const lines = fields.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  return ["", "---------- Forwarded message ---------", ...lines, "", original].join("\n");
}

/** Wrap the final body so it looks the same in every client. */
export function wrapOutgoingHtml(inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111">${inner}</div></body></html>`;
}
