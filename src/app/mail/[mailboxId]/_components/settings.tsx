"use client";

import type { ReactNode } from "react";
import { Switch } from "radix-ui";
import { ThemeToggle } from "@/components/theme-toggle";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useMail } from "./mail-context";

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { prefs, setPrefs } = useMail();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Settings</DialogTitle>
        <DialogDescription className="-mt-2">Saved to your account, on every device.</DialogDescription>
        <div className="divide-y rounded-xl border">
          <Row
            title="Show images automatically"
            description="Pictures in emails load through Matium Mail's privacy proxy, so senders don't see your IP address or device."
          >
            <Toggle
              checked={prefs.remoteImages === "proxy"}
              onChange={(on) => setPrefs({ remoteImages: on ? "proxy" : "ask" })}
              label="Show images automatically"
            />
          </Row>
          <Row title="Conversation view" description="Group replies with the message they answer.">
            <Toggle checked={prefs.conversationView} onChange={(on) => setPrefs({ conversationView: on })} label="Conversation view" />
          </Row>
          <Row title="Appearance">
            <ThemeToggle />
          </Row>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Row({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 p-3.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <Switch.Root
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        checked ? "bg-brand" : "bg-muted-foreground/30",
      )}
    >
      <Switch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[22px]" />
    </Switch.Root>
  );
}

const SHORTCUTS: Array<[string, string]> = [
  ["c", "Compose"],
  ["/", "Search"],
  ["j / k", "Next / previous conversation"],
  ["Enter or o", "Open conversation"],
  ["u or Esc", "Back to the list"],
  ["r", "Reply"],
  ["a", "Reply all"],
  ["f", "Forward"],
  ["e", "Archive"],
  ["#", "Delete"],
  ["s", "Star / unstar"],
  ["Shift + i", "Mark as read"],
  ["Shift + u", "Mark as unread"],
  ["Ctrl/⌘ + Enter", "Send (in the composer)"],
  ["?", "This list"],
];

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          {SHORTCUTS.map(([keys, what]) => (
            <div key={keys} className="contents">
              <dt>
                <kbd className="rounded-md border bg-muted px-1.5 py-0.5 font-mono text-xs">{keys}</kbd>
              </dt>
              <dd className="text-muted-foreground">{what}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
