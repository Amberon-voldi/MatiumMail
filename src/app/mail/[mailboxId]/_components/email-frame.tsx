"use client";

import { useEffect, useRef, useState } from "react";

/**
 * An email body, rendered from the server's sanitised document.
 *
 * Sandbox: no allow-scripts, so nothing in the email can run. allow-same-origin
 * only lets THIS page measure the content (to size the frame to the email, so
 * there is one scroll instead of a scroll-box inside the page) and shrink wide
 * newsletters to fit phone screens; without script it gives the email nothing.
 * Popups are allowed so links open in a new tab, escaping the sandbox.
 */
export function EmailFrame({
  html,
  title,
  onMailto,
}: {
  html: string;
  title: string;
  /** Called instead of leaving the app when a mailto: link is clicked. */
  onMailto?: (address: string) => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(160);
  const mailtoRef = useRef(onMailto);
  useEffect(() => {
    mailtoRef.current = onMailto;
  }, [onMailto]);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | undefined;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let raf = 0;

    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const doc = frame.contentDocument;
        if (!doc?.body) return;
        const body = doc.body;
        body.style.removeProperty("zoom");
        const available = frame.clientWidth;
        const needed = Math.max(doc.documentElement.scrollWidth, body.scrollWidth);
        // Fit wide (fixed 600-700px) newsletters to narrow screens instead of scrolling sideways.
        const zoom = available > 0 && needed > available + 4 ? Math.max(0.4, available / needed) : 1;
        if (zoom < 1) body.style.setProperty("zoom", String(zoom));
        // Measure the email itself, never the frame: the document is always at
        // least as tall as the frame, so measuring that could only ever grow.
        const style = doc.defaultView?.getComputedStyle(body);
        const margins = style ? (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0) : 0;
        const content = Math.max(body.getBoundingClientRect().height, body.scrollHeight * zoom) + margins * zoom;
        const next = Math.max(40, Math.ceil(content));
        setHeight((h) => (Math.abs(h - next) > 1 ? next : h));
      });
    };

    const onClick = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || !mailtoRef.current) return;
      const href = link.getAttribute("href") ?? "";
      if (/^mailto:/i.test(href)) {
        e.preventDefault();
        const address = decodeURIComponent(href.slice(7).split("?")[0]);
        if (address) mailtoRef.current(address);
      }
    };

    const attach = () => {
      const doc = frame.contentDocument;
      if (!doc) return;
      measure();
      doc.addEventListener("load", measure, true); // images finishing load
      doc.addEventListener("click", onClick);
      try {
        observer?.disconnect();
        observer = new ResizeObserver(measure);
        observer.observe(doc.body);
        observer.observe(frame);
      } catch {
        /* older browsers: the timed re-measures below still cover image loads */
      }
      for (const ms of [120, 600, 1500, 3500]) timers.push(setTimeout(measure, ms));
    };

    frame.addEventListener("load", attach);
    if (frame.contentDocument?.readyState === "complete") attach();
    return () => {
      frame.removeEventListener("load", attach);
      observer?.disconnect();
      timers.forEach(clearTimeout);
      cancelAnimationFrame(raf);
      const doc = frame.contentDocument;
      doc?.removeEventListener("load", measure, true);
      doc?.removeEventListener("click", onClick);
    };
  }, [html]);

  return (
    <iframe
      ref={ref}
      title={title}
      srcDoc={html}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      style={{ height }}
      className="block w-full border-0 bg-white"
    />
  );
}
