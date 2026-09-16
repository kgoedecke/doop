import * as React from 'react'

import { cn } from '@/lib/utils'

/* The signed-in shell: a fixed rail on the left, a dot-grid working area on
   the right. Home, Settings and Admin all wear it, so the rail's width, the
   header's height and the phone breakpoint live here once. Below md the rail
   is hidden and each page surfaces its navigation in the header instead. */

function DashLayout({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dash-layout"
      className={cn('grid h-full grid-cols-1 bg-paper md:grid-cols-[236px_1fr]', className)}
      {...props}
    />
  )
}

function DashSidebar({ className, ...props }: React.ComponentProps<'aside'>) {
  return (
    <aside
      data-slot="dash-sidebar"
      className={cn(
        'hidden flex-col overflow-y-auto border-r border-line bg-surface px-3.5 pb-[18px] pt-5 md:flex',
        className,
      )}
      {...props}
    />
  )
}

/** The uppercase caption over a group in the rail. */
function DashSectionLabel({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dash-section-label"
      className={cn(
        'px-2.5 pb-2 pt-[22px] text-[10px] font-bold uppercase tracking-[0.15em] text-ink-faint',
        className,
      )}
      {...props}
    />
  )
}

function DashNavItem({
  icon,
  count,
  active,
  className,
  children,
  ...props
}: React.ComponentProps<'button'> & {
  icon?: React.ReactNode
  count?: React.ReactNode
  active?: boolean
}) {
  return (
    <button
      type="button"
      data-slot="dash-nav-item"
      data-active={active || undefined}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex w-full items-center gap-[9px] rounded-[9px] border-0 bg-transparent px-2.5 py-2 text-left text-[13px] font-medium text-ink-soft transition-colors hover:bg-paper hover:text-ink data-[active]:bg-paper-deep data-[active]:font-semibold data-[active]:text-ink',
        className,
      )}
      {...props}
    >
      {icon}
      <span className="min-w-0 truncate">{children}</span>
      {count !== undefined && count !== null ? (
        <span className="ml-auto font-mono text-[11px] text-ink-faint">{count}</span>
      ) : null}
    </button>
  )
}

/** The working area: dot grid with the brand's glow in the corner. */
function DashMain({ className, ...props }: React.ComponentProps<'section'>) {
  return (
    <section
      data-slot="dash-main"
      className={cn(
        'flex min-w-0 flex-col overflow-hidden [background:radial-gradient(circle,var(--dot)_1px,transparent_1px)_0_0/26px_26px,var(--paper)]',
        className,
      )}
      {...props}
    />
  )
}

/** Sticky top bar. It wraps to two rows on a phone, where pages put their
 *  breadcrumb on one line and their actions on the next. */
function DashHeader({ className, ...props }: React.ComponentProps<'header'>) {
  return (
    <header
      data-slot="dash-header"
      className={cn(
        'flex h-auto min-h-[60px] flex-none flex-wrap items-center gap-2 border-b border-line bg-surface/75 px-4 py-3 backdrop-blur-sm md:h-[60px] md:flex-nowrap md:gap-3 md:px-[26px] md:py-0',
        className,
      )}
      {...props}
    />
  )
}

function DashContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dash-content"
      className={cn(
        'flex-1 overflow-y-auto px-4 pb-[calc(40px+env(safe-area-inset-bottom))] pt-5 md:px-[26px] md:pb-10 md:pt-6',
        className,
      )}
      {...props}
    />
  )
}

function DashTitle({ className, ...props }: React.ComponentProps<'h1'>) {
  return (
    <h1
      data-slot="dash-title"
      className={cn(
        'font-serif text-[34px] font-normal leading-[1.05] tracking-[-0.015em] md:text-[38px] md:leading-none',
        className,
      )}
      {...props}
    />
  )
}

function DashSubtitle({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="dash-subtitle"
      className={cn('mt-[7px] text-[13px] leading-[1.45] text-ink-soft md:leading-normal', className)}
      {...props}
    />
  )
}

export {
  DashLayout,
  DashSidebar,
  DashSectionLabel,
  DashNavItem,
  DashMain,
  DashHeader,
  DashContent,
  DashTitle,
  DashSubtitle,
}
