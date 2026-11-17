"use client";

import Link from "next/link";
import { useActionState } from "react";
import { CheckCircle2, Loader2, Send } from "lucide-react";
import type { SendState } from "@/app/actions/mail";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Defaults = { to?: string; subject?: string; inReplyTo?: string };

export function ComposeForm({
  action,
  from,
  defaults,
  backHref,
}: {
  action: (prev: SendState, form: FormData) => Promise<SendState>;
  from: string;
  defaults: Defaults;
  backHref: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});

  if (state.sent) {
    return (
      <div className="mx-auto mt-24 max-w-sm text-center">
        <CheckCircle2 className="mx-auto size-10 text-emerald-500" aria-hidden="true" />
        <h2 className="mt-4 text-lg font-semibold">Message sent</h2>
        <p className="mt-1 text-sm text-muted-foreground">A copy was saved to your Sent folder.</p>
        <Button asChild className="mt-6" variant="outline">
          <Link href={backHref}>Back to mail</Link>
        </Button>
      </div>
    );
  }

  return (
    <form action={formAction} className="mx-auto w-full max-w-3xl space-y-4 p-6">
      <p className="text-xs text-muted-foreground">From {from}</p>
      {defaults.inReplyTo ? <input type="hidden" name="inReplyTo" value={defaults.inReplyTo} /> : null}
      <Field label="To" name="to" defaultValue={defaults.to} placeholder="name@example.com, another@example.com" autoFocus={!defaults.to} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Cc" name="cc" />
        <Field label="Bcc" name="bcc" />
      </div>
      <Field label="Subject" name="subject" defaultValue={defaults.subject} autoFocus={Boolean(defaults.to)} />
      <div className="space-y-2">
        <Label htmlFor="body">Message</Label>
        <textarea
          id="body"
          name="body"
          rows={14}
          className="w-full resize-y rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </div>
      {state.error ? (
        <p role="alert" className="rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending} className="gap-2">
          {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send className="size-4" aria-hidden="true" />}
          {pending ? "Sending… (the mail server can take ~30 s)" : "Send"}
        </Button>
        <Button asChild variant="ghost" type="button">
          <Link href={backHref}>Discard</Link>
        </Button>
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  defaultValue,
  placeholder,
  autoFocus,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} defaultValue={defaultValue} placeholder={placeholder} autoFocus={autoFocus} spellCheck={false} />
    </div>
  );
}
