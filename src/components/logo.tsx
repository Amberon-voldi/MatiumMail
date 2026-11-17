import Image from "next/image";
import markDark from "@/assets/brand/mark-dark.png";
import markLight from "@/assets/brand/mark-light.png";
import { cn } from "@/lib/utils";

/**
 * The MatiumTech "mt" monogram as a rounded tile: white on black in the light
 * theme, black on white in the dark theme (same contrast as the old mark).
 */
export function Logo({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "relative inline-flex size-10 shrink-0 overflow-hidden rounded-xl shadow-sm ring-1 ring-foreground/10",
        className,
      )}
    >
      <Image src={markDark} alt="" fill sizes="64px" unoptimized className="object-cover dark:hidden" />
      <Image src={markLight} alt="" fill sizes="64px" unoptimized className="hidden object-cover dark:block" />
      <span className="sr-only">Matium Mail</span>
    </span>
  );
}

/** Logo plus the product name, for headers and sidebars. */
export function Wordmark({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <Logo className={compact ? "size-7 rounded-lg" : "size-8 rounded-[10px]"} />
      <span className="text-[15px] leading-none font-semibold tracking-tight" aria-hidden="true">
        Matium <span className="text-brand">Mail</span>
      </span>
    </span>
  );
}
