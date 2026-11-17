"use client";

import type { ComponentProps, ReactNode } from "react";
import { Loader2 } from "lucide-react";
import type { Addr } from "@/lib/mail-types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { avatarClass, initials } from "../_lib/format";

/** Sender avatar: initials on a stable colour. */
export function Avatar({ addr, className }: { addr: Addr | null | undefined; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold select-none",
        avatarClass(addr),
        className,
      )}
    >
      {initials(addr)}
    </span>
  );
}

/** Icon-only button with an accessible name and a tooltip; larger touch target on phones. */
export function IconButton({
  label,
  children,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "aria-label"> & { label: string; children: ReactNode }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      className={cn("size-10 rounded-full text-muted-foreground hover:text-foreground md:size-8 md:rounded-lg", className)}
      {...props}
    >
      {children}
    </Button>
  );
}

export function Spinner({ className, label = "Loading" }: { className?: string; label?: string }) {
  return (
    <span role="status" className="inline-flex items-center">
      <Loader2 className={cn("size-4 animate-spin text-muted-foreground", className)} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  className,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-16 text-center", className)}>
      <div className="flex size-14 items-center justify-center rounded-2xl border bg-muted/40 text-muted-foreground [&_svg]:size-6">
        {icon}
      </div>
      <p className="mt-4 text-sm font-medium">{title}</p>
      {children ? <div className="mt-1.5 max-w-xs text-sm text-muted-foreground">{children}</div> : null}
    </div>
  );
}

/** Shimmering placeholder rows while a list loads. */
export function ListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="divide-y">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex gap-3 px-4 py-3.5">
          <div className="size-9 shrink-0 animate-pulse rounded-full bg-muted" />
          <div className="min-w-0 flex-1 space-y-2 pt-0.5">
            <div className="flex justify-between gap-6">
              <div className="h-3.5 w-1/3 animate-pulse rounded bg-muted" />
              <div className="h-3 w-10 animate-pulse rounded bg-muted" />
            </div>
            <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-muted/70" />
          </div>
        </div>
      ))}
    </div>
  );
}
