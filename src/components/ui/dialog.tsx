"use client"

import * as React from "react"
import { cn } from "cn"
import { XIcon } from "lucide-react"
import { Dialog as D } from "radix-ui"

const Dialog = D.Root
const DialogTrigger = D.Trigger
const DialogClose = D.Close

/** Centered dialog on larger screens, bottom sheet on phones. */
function DialogContent({
  className,
  children,
  showClose = true,
  ...props
}: React.ComponentProps<typeof D.Content> & { showClose?: boolean }) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
      <D.Content
        data-slot="dialog-content"
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 grid max-h-[92dvh] w-full gap-4 overflow-y-auto rounded-t-2xl border bg-background p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-xl outline-none data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom-8 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:pb-5 sm:data-[state=open]:zoom-in-95 sm:data-[state=open]:slide-in-from-bottom-0",
          className
        )}
        {...props}
      >
        {children}
        {showClose ? (
          <D.Close className="absolute top-3.5 right-3.5 inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
            <XIcon className="size-4" />
            <span className="sr-only">Close</span>
          </D.Close>
        ) : null}
      </D.Content>
    </D.Portal>
  )
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof D.Title>) {
  return <D.Title className={cn("pr-8 text-base font-semibold tracking-tight", className)} {...props} />
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof D.Description>) {
  return <D.Description className={cn("text-sm text-muted-foreground", className)} {...props} />
}

export { Dialog, DialogTrigger, DialogClose, DialogContent, DialogTitle, DialogDescription }
