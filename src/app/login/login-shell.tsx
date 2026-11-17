import type { ReactNode } from "react";
import { Lock } from "lucide-react";
import { Logo } from "@/components/logo";

/** Frame shared by the sign-in and add-account pages. */
export function LoginShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-16">
      {/* Soft backdrop: a faint radial wash + hairline grid, theme-aware */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60rem_40rem_at_50%_-10%,color-mix(in_oklch,var(--foreground)_6%,transparent),transparent)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 [background-image:linear-gradient(to_right,color-mix(in_oklch,var(--foreground)_4%,transparent)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_oklch,var(--foreground)_4%,transparent)_1px,transparent_1px)] [background-size:48px_48px] [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_70%)]"
      />

      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-56 left-[calc(50%-20rem)] size-[40rem] rounded-full bg-brand/15 blur-3xl motion-safe:animate-drift dark:bg-brand/20"
      />

      <div className="relative w-full max-w-[380px] motion-safe:animate-fade-up">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo className="motion-safe:animate-float" />
          <h1 className="mt-6 text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>
        </div>

        <div className="rounded-2xl border bg-card/80 p-6 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-12px_rgb(0_0_0/0.12)] backdrop-blur-sm">
          {children}
        </div>

        <p className="mt-6 flex items-start justify-center gap-2 text-center text-xs leading-relaxed text-muted-foreground">
          <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            Mailbox passwords are checked with your mail server over an encrypted connection and stored encrypted.
          </span>
        </p>
      </div>
    </main>
  );
}
