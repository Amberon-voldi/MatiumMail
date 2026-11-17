"use client"

import * as React from "react"
import { cn } from "cn"
import { CheckIcon, ChevronRightIcon } from "lucide-react"
import { DropdownMenu as Menu } from "radix-ui"

const DropdownMenu = Menu.Root
const DropdownMenuTrigger = Menu.Trigger
const DropdownMenuGroup = Menu.Group
const DropdownMenuSub = Menu.Sub

function DropdownMenuContent({ className, sideOffset = 6, ...props }: React.ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-44 overflow-x-hidden overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className
        )}
        {...props}
      />
    </Menu.Portal>
  )
}

function DropdownMenuItem({
  className,
  variant,
  ...props
}: React.ComponentProps<typeof Menu.Item> & { variant?: "destructive" }) {
  return (
    <Menu.Item
      data-slot="dropdown-menu-item"
      className={cn(
        "relative flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none select-none focus:bg-muted data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        variant === "destructive" && "text-destructive focus:bg-destructive/10 [&_svg:not([class*='text-'])]:text-destructive",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuCheckboxItem({ className, children, ...props }: React.ComponentProps<typeof Menu.CheckboxItem>) {
  return (
    <Menu.CheckboxItem
      className={cn(
        "relative flex cursor-default items-center gap-2.5 rounded-lg py-2 pr-2.5 pl-8 text-sm outline-none select-none focus:bg-muted data-disabled:pointer-events-none data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <span className="absolute left-2.5 flex size-4 items-center justify-center">
        <Menu.ItemIndicator>
          <CheckIcon className="size-4" />
        </Menu.ItemIndicator>
      </span>
      {children}
    </Menu.CheckboxItem>
  )
}

function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof Menu.Label>) {
  return <Menu.Label className={cn("px-2.5 py-1.5 text-xs font-medium text-muted-foreground", className)} {...props} />
}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof Menu.Separator>) {
  return <Menu.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />
}

function DropdownMenuSubTrigger({ className, children, ...props }: React.ComponentProps<typeof Menu.SubTrigger>) {
  return (
    <Menu.SubTrigger
      className={cn(
        "flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none select-none focus:bg-muted data-[state=open]:bg-muted [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4" />
    </Menu.SubTrigger>
  )
}

function DropdownMenuSubContent({ className, ...props }: React.ComponentProps<typeof Menu.SubContent>) {
  return (
    <Menu.Portal>
      <Menu.SubContent
        className={cn(
          "z-50 max-h-80 min-w-44 overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          className
        )}
        {...props}
      />
    </Menu.Portal>
  )
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
}
