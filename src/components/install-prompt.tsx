"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Download, EllipsisVertical, Share, SquarePlus, X } from "lucide-react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";

/**
 * "Add to Home Screen" for the signed-in app.
 *
 * Chromium browsers (Android Chrome, Edge, Samsung Internet) fire
 * `beforeinstallprompt` once the site is installable. This module catches it
 * on every page — it is loaded from the root layout via <InstallCapture />, so
 * the event isn't lost on the sign-in page — and replays it from our own
 * Install button. iOS has no such event, so Safari users are shown the two
 * taps to make instead, as are browsers that never offer one.
 */

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type InstallState = {
  /** The browser's own install prompt, when it offered one. Usable once. */
  deferred: BeforeInstallPromptEvent | null;
  /** Running as the installed app, or installed during this visit. */
  installed: boolean;
  open: boolean;
};

const SERVER_STATE: InstallState = { deferred: null, installed: false, open: false };
let state = SERVER_STATE;
const listeners = new Set<() => void>();

function update(patch: Partial<InstallState>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

if (typeof window !== "undefined") {
  state = { ...state, installed: isStandalone() };
  window.addEventListener("beforeinstallprompt", (e) => {
    // Keep the browser's own mini-infobar away; the app offers it after sign-in.
    e.preventDefault();
    update({ deferred: e as BeforeInstallPromptEvent });
  });
  window.addEventListener("appinstalled", () => update({ deferred: null, installed: true, open: false }));
}

// ── Device ────────────────────────────────────────────────────────────────

const TOUCH_QUERY = "(pointer: coarse) and (hover: none)";

/** Phones and tablets: a touch screen and no mouse. */
function subscribeTouch(fn: () => void) {
  const mq = window.matchMedia(TOUCH_QUERY);
  mq.addEventListener("change", fn);
  return () => mq.removeEventListener("change", fn);
}

function useIsTouchDevice(): boolean {
  return useSyncExternalStore(subscribeTouch, () => window.matchMedia(TOUCH_QUERY).matches, () => false);
}

/** iPhone, iPod and iPad (iPadOS reports itself as a Mac with a touch screen). */
function isIOS(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

// ── "Not now" ─────────────────────────────────────────────────────────────

const SNOOZE_KEY = "mm:install-snoozed-until";
const SNOOZE_MS = 14 * 86_400_000;

function isSnoozed(): boolean {
  try {
    return Number(localStorage.getItem(SNOOZE_KEY)) > Date.now();
  } catch {
    return false;
  }
}

function snooze() {
  try {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
  } catch {
    // Storage blocked (private mode): the offer just comes back next visit.
  }
}

// ── Public API ────────────────────────────────────────────────────────────

const useInstallState = () => useSyncExternalStore(subscribe, () => state, () => SERVER_STATE);

/** Loads this module on every page so the browser's install event is never missed. */
export function InstallCapture() {
  return null;
}

/** Whether to list "Install app" in a menu: not installed, and the device can install it. */
export function useCanInstall(): boolean {
  const s = useInstallState();
  const touch = useIsTouchDevice();
  return !s.installed && (s.deferred !== null || touch);
}

/** Show the install card now (from a menu), even if it was put off earlier. */
export function openInstallPrompt() {
  update({ open: true });
}

const AUTO_OPEN_DELAY_MS = 2500;

/**
 * The install card. Opens by itself on phones and tablets a moment after the
 * app loads, unless the app is already installed or the user said "Not now"
 * in the last two weeks.
 */
export function InstallPrompt({ suppressed = false }: { suppressed?: boolean }) {
  const s = useInstallState();

  useEffect(() => {
    if (state.installed || state.open || !window.matchMedia(TOUCH_QUERY).matches || isSnoozed()) return;
    const timer = setTimeout(() => update({ open: true }), AUTO_OPEN_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  if (!s.open || s.installed || suppressed) return null;

  const dismiss = () => {
    snooze();
    update({ open: false });
  };

  const install = async () => {
    const prompt = state.deferred;
    if (!prompt) return;
    update({ deferred: null }); // the browser allows each prompt to be shown once
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === "accepted") update({ open: false, installed: true });
    else dismiss();
  };

  return (
    <div
      role="dialog"
      aria-labelledby="install-title"
      aria-describedby="install-description"
      className="bottom-safe fixed inset-x-3 z-40 mx-auto max-w-md rounded-3xl border bg-popover p-4 text-popover-foreground shadow-2xl shadow-black/20 motion-safe:animate-fade-up"
    >
      <div className="flex items-start gap-3">
        <Logo className="size-12 rounded-2xl" />
        <div className="min-w-0 flex-1 pt-0.5">
          <p id="install-title" className="font-semibold tracking-tight">
            Add Matium Mail to your home screen
          </p>
          <p id="install-description" className="mt-0.5 text-sm text-muted-foreground">
            Open your inbox in one tap, full screen, like an app.
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Not now"
          className="-mt-1 -mr-1 inline-flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      {s.deferred ? (
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" className="h-10 rounded-xl" onClick={dismiss}>
            Not now
          </Button>
          <Button className="h-10 gap-2 rounded-xl bg-brand px-4 text-brand-foreground hover:bg-brand/90" onClick={() => void install()}>
            <Download className="size-4" /> Install
          </Button>
        </div>
      ) : (
        <>
          <ol className="mt-3 space-y-2 rounded-2xl bg-muted/60 p-3 text-sm">
            {isIOS() ? (
              <>
                <Step n={1}>
                  Tap <Share className="mx-0.5 inline size-4 -translate-y-px text-brand" aria-hidden="true" /> <b>Share</b> (in newer Safari
                  it&apos;s under <b>•••</b>)
                </Step>
                <Step n={2}>
                  Choose <SquarePlus className="mx-0.5 inline size-4 -translate-y-px text-brand" aria-hidden="true" />{" "}
                  <b>Add to Home Screen</b>
                </Step>
              </>
            ) : (
              <>
                <Step n={1}>
                  Open the browser menu <EllipsisVertical className="inline size-4 -translate-y-px text-brand" aria-hidden="true" />
                </Step>
                <Step n={2}>
                  Choose <b>Install app</b> or <b>Add to Home screen</b>
                </Step>
              </>
            )}
          </ol>
          <div className="mt-3 flex justify-end">
            <Button variant="ghost" className="h-10 rounded-xl" onClick={dismiss}>
              Got it
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-px inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[11px] font-semibold text-brand">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}
