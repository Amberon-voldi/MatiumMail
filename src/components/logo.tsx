import { cn } from "@/lib/utils";

/** Matium Mail mark: a rounded tile with an open-envelope fold. */
export function Logo({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex size-10 items-center justify-center rounded-xl bg-foreground text-background shadow-sm",
        className,
      )}
    >
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="size-5">
        <path
          d="M4 8.5 12 13l8-4.5M5.5 6h13A1.5 1.5 0 0 1 20 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5v-9A1.5 1.5 0 0 1 5.5 6Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="sr-only">Matium Mail</span>
    </span>
  );
}
