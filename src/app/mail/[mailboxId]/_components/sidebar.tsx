"use client";

import Link from "next/link";
import { useRef } from "react";
import {
  Archive,
  Check,
  ChevronsUpDown,
  FileText,
  Folder,
  Inbox,
  Keyboard,
  LogOut,
  Mails,
  OctagonAlert,
  PenSquare,
  Plus,
  Send,
  Settings,
  Star,
  Trash2,
  Users,
} from "lucide-react";
import { signOutAction } from "@/app/actions/auth";
import type { FolderDTO, FolderRole } from "@/lib/mail-types";
import { Wordmark } from "@/components/logo";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { Avatar } from "./bits";
import { useMail, type OtherMailbox, type SignedInAccount } from "./mail-context";

const ICONS: Record<FolderRole, typeof Inbox> = {
  INBOX: Inbox,
  DRAFTS: FileText,
  SENT: Send,
  ARCHIVE: Archive,
  JUNK: OctagonAlert,
  TRASH: Trash2,
  FLAGGED: Star,
  ALL: Mails,
  NONE: Folder,
};

export function Sidebar({
  mailboxes,
  accounts,
  onNavigate,
  onOpenSettings,
  onOpenShortcuts,
}: {
  mailboxes: OtherMailbox[];
  accounts: SignedInAccount[];
  /** Called after choosing a folder (closes the drawer on phones). */
  onNavigate: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
}) {
  const mail = useMail();
  const { folders, nav, navigate } = mail;
  const system = folders.filter((f) => f.role !== "NONE");
  const custom = folders.filter((f) => f.role === "NONE");

  const go = (f: FolderDTO) => {
    navigate({ folderId: f.id, threadId: null, q: "", all: false });
    onNavigate();
  };

  return (
    <div className="pt-safe pb-safe flex h-full min-h-0 flex-col bg-sidebar">
      <div className="flex h-14 shrink-0 items-center px-4">
        <Link href="/" aria-label="Matium Mail home" className="rounded-lg focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
          <Wordmark />
        </Link>
      </div>

      {mail.can.send ? (
        <div className="px-3 pb-3">
          <Button
            className="h-11 w-full justify-start gap-2.5 rounded-2xl bg-brand px-4 text-[15px] font-semibold text-brand-foreground shadow-sm shadow-brand/25 hover:bg-brand/90 md:h-10 md:text-sm"
            onClick={() => {
              mail.openComposer({ mode: "new" });
              onNavigate();
            }}
          >
            <PenSquare className="size-[18px]" /> Compose
          </Button>
        </div>
      ) : null}

      <nav aria-label="Folders" className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {folders.length === 0 ? (
          <div className="space-y-1.5 px-2 pt-1" aria-hidden="true">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="h-8 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : null}
        <ul className="space-y-0.5">
          {system.map((f) => (
            <FolderItem key={f.id} folder={f} active={!nav.q && f.id === nav.folderId} onClick={() => go(f)} />
          ))}
        </ul>
        {custom.length ? (
          <>
            <p className="mt-5 mb-1 px-3 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Folders</p>
            <ul className="space-y-0.5">
              {custom.map((f) => (
                <FolderItem key={f.id} folder={f} active={!nav.q && f.id === nav.folderId} onClick={() => go(f)} />
              ))}
            </ul>
          </>
        ) : null}
      </nav>

      <AccountMenu mailboxes={mailboxes} accounts={accounts} onOpenSettings={onOpenSettings} onOpenShortcuts={onOpenShortcuts} />
    </div>
  );
}

function FolderItem({ folder: f, active, onClick }: { folder: FolderDTO; active: boolean; onClick: () => void }) {
  const Icon = ICONS[f.role];
  // Drafts show how many there are; Sent and Trash show nothing; the rest show unread.
  const count = f.role === "DRAFTS" ? f.total : f.role === "SENT" || f.role === "TRASH" ? 0 : f.unread;
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? "page" : undefined}
        style={{ paddingLeft: 12 + f.depth * 14 }}
        className={cn(
          "flex h-11 w-full items-center gap-3 rounded-xl pr-3 text-left text-[15px] transition-colors md:h-9 md:text-sm",
          active ? "bg-brand-soft font-semibold text-brand" : "text-foreground/80 hover:bg-muted hover:text-foreground",
        )}
      >
        <Icon className={cn("size-[18px] shrink-0", active ? "text-brand" : "text-muted-foreground")} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{f.name}</span>
        {count > 0 ? (
          <span className={cn("text-xs tabular-nums", active || f.role === "INBOX" ? "font-semibold text-brand" : "text-muted-foreground")}>
            {count > 999 ? "999+" : count}
          </span>
        ) : null}
      </button>
    </li>
  );
}

function AccountMenu({
  mailboxes,
  accounts,
  onOpenSettings,
  onOpenShortcuts,
}: {
  mailboxes: OtherMailbox[];
  accounts: SignedInAccount[];
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
}) {
  const { mailbox } = useMail();
  const signOut = useRef<HTMLFormElement>(null);
  const me = { name: mailbox.displayName, address: mailbox.address };
  return (
    <div className="shrink-0 border-t p-2">
      <form ref={signOut} action={signOutAction} hidden />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex w-full items-center gap-2.5 rounded-xl p-2 text-left transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
            <Avatar addr={me} className="size-8 text-xs" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{mailbox.displayName ?? mailbox.address.split("@")[0]}</span>
              <span className="block truncate text-xs text-muted-foreground">{mailbox.address}</span>
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-64">
          {mailboxes.length > 1 ? (
            <>
              <DropdownMenuLabel>Mailboxes</DropdownMenuLabel>
              {mailboxes.map((m) => (
                <DropdownMenuItem key={m.id} asChild>
                  <Link href={`/mail/${m.id}`}>
                    <Avatar addr={{ name: m.displayName, address: m.address }} className="size-6 text-[10px]" />
                    <span className="min-w-0 flex-1 truncate">{m.address}</span>
                    {m.id === mailbox.id ? <Check className="text-brand" /> : null}
                    {m.status === "NEEDS_REAUTH" ? <span className="size-2 rounded-full bg-amber-500" title="Needs the new password" /> : null}
                  </Link>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem onSelect={onOpenSettings}>
            <Settings /> Settings
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onOpenShortcuts} className="hidden md:flex">
            <Keyboard /> Keyboard shortcuts
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/accounts">
              <Users /> Manage accounts
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/login/add">
              <Plus /> Add another account
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => signOut.current?.requestSubmit()}>
            <LogOut /> {accounts.length > 1 ? "Sign out of all accounts" : "Sign out"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
