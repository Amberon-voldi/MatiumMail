import { describe, expect, it } from "vitest";
import { emailDocument, escapeHtml, hasBlockedRemoteImages, previewFromHtml, sanitizeEmailHtml } from "./sanitize";

const clean = (html: string) => sanitizeEmailHtml(html);

describe("sanitizeEmailHtml — removes active content", () => {
  it.each([
    ["script tag", `<p>hi</p><script>alert(1)</script>`, /<script|alert/i],
    ["inline event handler", `<img src="cid:x" onerror="alert(1)">`, /onerror|alert/i],
    ["onload on body-ish div", `<div onload="steal()">x</div>`, /onload|steal/i],
    ["javascript: link", `<a href="javascript:alert(1)">x</a>`, /javascript:/i],
    ["entity-encoded javascript: link", `<a href="jav&#x61;script:alert(1)">x</a>`, /script:|alert/i],
    ["vbscript link", `<a href="vbscript:msgbox(1)">x</a>`, /vbscript/i],
    ["iframe", `<iframe src="https://evil.example"></iframe>`, /iframe|evil/i],
    ["object/embed", `<object data="x.swf"></object><embed src="x.swf">`, /object|embed|swf/i],
    ["form", `<form action="https://evil.example"><input name="p"></form>`, /<form|<input|evil/i],
    ["meta refresh", `<meta http-equiv="refresh" content="0;url=https://evil.example">`, /refresh|evil/i],
    ["base href hijack", `<base href="https://evil.example/">`, /<base|evil/i],
    ["link stylesheet", `<link rel="stylesheet" href="https://evil.example/x.css">`, /<link|evil/i],
    ["svg with script", `<svg><script>alert(1)</script></svg>`, /svg|script|alert/i],
    ["data:text/html image", `<img src="data:text/html;base64,PHNjcmlwdD4=">`, /data:text/i],
    ["data:svg image", `<img src="data:image/svg+xml;base64,PHN2Zz4=">`, /svg/i],
    ["protocol-relative link", `<a href="//evil.example">x</a>`, /evil/i],
  ])("%s", (_label, input, forbidden) => {
    expect(clean(input)).not.toMatch(forbidden);
  });
});

describe("sanitizeEmailHtml — keeps legitimate email markup", () => {
  it("keeps tables, inline styles and <style> blocks", () => {
    const out = clean(`<style>.x{color:red}</style><table width="100%" cellpadding="0"><tr><td style="color:#333" bgcolor="#fff">Hi</td></tr></table>`);
    expect(out).toContain("<style>.x{color:red}</style>");
    expect(out).toContain('cellpadding="0"');
    expect(out).toContain('style="color:#333"');
  });

  it("forces links to open in a new tab without referrer/opener", () => {
    const out = clean(`<a href="https://example.com/x">x</a>`);
    expect(out).toContain('href="https://example.com/x"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });

  it("keeps mailto and tel links", () => {
    expect(clean(`<a href="mailto:a@b.co">m</a>`)).toContain('href="mailto:a@b.co"');
    expect(clean(`<a href="tel:+911234">t</a>`)).toContain('href="tel:+911234"');
  });

  it("keeps cid: and raster data: images", () => {
    expect(clean(`<img src="cid:logo@x">`)).toContain('src="cid:logo@x"');
    expect(clean(`<img src="data:image/png;base64,iVBORw0KGgo=">`)).toContain("data:image/png");
  });

  it("parks remote images instead of loading them", () => {
    const out = clean(`<img src="https://tracker.example/pixel.gif" width="1">`);
    expect(out).not.toMatch(/\ssrc=/);
    expect(out).toContain('data-remote-src="https://tracker.example/pixel.gif"');
    expect(hasBlockedRemoteImages(out)).toBe(true);
  });
});

describe("emailDocument", () => {
  it("blocks scripts and remote loads by default", () => {
    const doc = emailDocument(clean(`<img src="https://t.example/p.gif"><p>x</p>`));
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("img-src data: cid:;");
    // A real src attribute (preceded by whitespace), not the parked data-remote-src.
    expect(doc).not.toMatch(/\ssrc="https:\/\/t\.example/);
  });

  it("restores remote images only when allowed", () => {
    const doc = emailDocument(clean(`<img src="https://t.example/p.gif">`), { allowRemoteImages: true });
    expect(doc).toContain('src="https://t.example/p.gif"');
    expect(doc).toContain("img-src data: cid: https: http:");
    expect(doc).not.toContain("script-src");
  });
});

describe("previewFromHtml", () => {
  it("drops CSS/script/head content and tags", () => {
    const html = `<html><head><title>T</title><style>body,table,td{font-family:Arial}</style></head><body><p>Hello&nbsp;<b>there</b></p><script>x()</script><div>Second line &amp; more</div></body></html>`;
    expect(previewFromHtml(html)).toBe("Hello there Second line & more");
  });
  it("truncates", () => {
    expect(previewFromHtml(`<p>${"a".repeat(500)}</p>`, 10)).toBe("aaaaaaaaaa");
  });
});

describe("escapeHtml", () => {
  it("escapes markup characters", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });
});
