import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'
import { navigate } from '@/lib/navigate'
import { useRailDrawer } from '@/lib/railDrawer'
import { useT } from '@/lib/i18n'
import { Logo } from '../Logo'
import { IconButton } from './icon-button'
import { ChevronDownIcon, PanelLeftIcon } from './icons'
import { Wordmark } from './wordmark'

/* The signed-in shell: a fixed rail on the left, a dot-grid working area on
   the right. Home, Settings and Admin all wear it, so the rail's width, the
   header's height and the phone breakpoint live here once. Below md the rail
   is hidden; on a page that mounts the AppRail the header draws the brand row
   (rail toggle + wordmark) that opens it as a drawer. */

function DashLayout({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dash-layout"
      className={cn('grid h-full grid-cols-1 bg-paper md:grid-cols-[236px_1fr]', className)}
      {...props}
    />
  )
}

const dashSidebarVariants = cva('hidden flex-col overflow-y-auto md:flex', {
  variants: {
    variant: {
      /* a bordered white panel */
      default: 'border-r border-line bg-surface px-3.5 pb-[18px] pt-5',
      /* the app rail: borderless on the sub fill, 236px wide */
      rail: 'overflow-x-hidden bg-sub px-3 pb-3 pt-3.5 md:w-[236px]',
    },
  },
  defaultVariants: { variant: 'default' },
})

function DashSidebar({
  variant,
  className,
  ...props
}: React.ComponentProps<'aside'> & VariantProps<typeof dashSidebarVariants>) {
  return (
    <aside
      data-slot="dash-sidebar"
      data-variant={variant ?? 'default'}
      className={cn(dashSidebarVariants({ variant }), className)}
      {...props}
    />
  )
}

/** The rail's top row: the Disc-D as the way home, and room after it for the
 *  rail's own controls (search, hide). */
function DashSidebarBrand({
  onHome = () => navigate('/'),
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & { onHome?: () => void }) {
  const t = useT()
  return (
    <div
      data-slot="dash-sidebar-brand"
      className={cn('mb-2.5 flex h-[30px] flex-none items-center gap-2 px-1.5', className)}
      {...props}
    >
      <IconButton
        aria-label={t('ui.doopHome')}
        className="size-[26px] rounded-row hover:bg-transparent"
        onClick={onHome}
      >
        <Logo className="size-[26px] rounded-row" />
      </IconButton>
      {children}
    </div>
  )
}

type DashDensity = 'default' | 'rail'

/** The caption over a group in the rail: sentence case, a quiet grey. The
 *  rail density sits it tighter over the 31px rows and adds the chevron. */
function DashSectionLabel({
  density = 'default',
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & { density?: DashDensity }) {
  return (
    <div
      data-slot="dash-section-label"
      className={cn(
        'text-caption text-ink-faint [[data-rail=narrow]_&]:hidden',
        density === 'rail' ? 'flex items-center gap-[5px] px-[11px] pb-1.5 pt-3.5' : 'px-2.5 pb-2 pt-[22px]',
        className,
      )}
      {...props}
    >
      {children}
      {density === 'rail' ? <ChevronDownIcon width={11} height={11} className="text-ink-ghost" aria-hidden /> : null}
    </div>
  )
}

/* Inside a narrow rail (`[data-rail="narrow"]`, the collapsed AppRail) a row
   shrinks to its glyph: the label stays for screen readers, counts hide. */
const NARROW_ROW =
  '[[data-rail=narrow]_&]:size-8 [[data-rail=narrow]_&]:justify-center [[data-rail=narrow]_&]:gap-0 [[data-rail=narrow]_&]:px-0'

const dashNavItemVariants = cva(
  cn('flex w-full min-w-0 items-center text-left text-body text-ink-soft [&_svg]:flex-none', NARROW_ROW),
  {
    variants: {
      density: {
        default: 'gap-[9px] rounded-[9px] px-2.5 py-2 font-medium',
        /* the app rail's row: 31px tall, 11px gaps, regular weight throughout */
        rail: 'h-[31px] gap-[11px] rounded-row px-[11px] py-0 font-normal',
      },
      interactive: {
        true: 'border-0 bg-transparent transition-colors hover:text-ink data-[active]:bg-paper-deep data-[active]:text-ink',
        false: '',
      },
    },
    compoundVariants: [
      { density: 'default', interactive: true, className: 'hover:bg-paper data-[active]:font-semibold' },
      { density: 'rail', interactive: true, className: 'hover:bg-paper-deep' },
    ],
    defaultVariants: { density: 'default', interactive: true },
  },
)

type DashNavItemOwnProps = {
  icon?: React.ReactNode
  /** a number at the right edge, in mono */
  count?: React.ReactNode
  /** anything else at the right edge (a status dot, a timestamp), drawn as given */
  trailing?: React.ReactNode
  active?: boolean
  density?: DashDensity
}

type DashNavItemProps = DashNavItemOwnProps &
  (
    | ({ as?: 'button' } & Omit<React.ComponentProps<'button'>, keyof DashNavItemOwnProps>)
    /* a static row: the same box with nothing to press (the rail's agents) */
    | ({ as: 'div' } & Omit<React.ComponentProps<'div'>, keyof DashNavItemOwnProps>)
  )

function navItemBody({ icon, count, trailing, children }: DashNavItemOwnProps & { children?: React.ReactNode }) {
  return (
    <>
      {icon}
      <span className="min-w-0 truncate [[data-rail=narrow]_&]:sr-only">{children}</span>
      {count !== undefined && count !== null ? (
        <span className="ml-auto flex-none font-mono text-caption text-ink-faint [[data-rail=narrow]_&]:hidden">
          {count}
        </span>
      ) : null}
      {trailing !== undefined && trailing !== null ? (
        <span className="ml-auto flex flex-none items-center [[data-rail=narrow]_&]:hidden">{trailing}</span>
      ) : null}
    </>
  )
}

/** One row of a sidebar. `density="rail"` is the app rail's row; `as="div"`
 *  draws it static, for a row that only reports something. */
function DashNavItem(props: DashNavItemProps) {
  if (props.as === 'div') {
    const { as: _as, icon, count, trailing, active: _active, density, className, children, ...rest } = props
    return (
      <div
        data-slot="dash-nav-item"
        className={cn(dashNavItemVariants({ density, interactive: false }), className)}
        {...rest}
      >
        {navItemBody({ icon, count, trailing, children })}
      </div>
    )
  }
  const { as: _as, icon, count, trailing, active, density, className, children, ...rest } = props
  return (
    <button
      type="button"
      data-slot="dash-nav-item"
      data-active={active || undefined}
      aria-current={active ? 'page' : undefined}
      className={cn(dashNavItemVariants({ density, interactive: true }), className)}
      {...rest}
    >
      {navItemBody({ icon, count, trailing, children })}
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

/** The phone's stand-in for the rail: the toggle that opens it as a drawer
 *  and the wordmark home link. Renders nothing on desktop, and nothing on a
 *  page without an AppRail (those draw their own sidebar or breadcrumb). */
function DashBrand() {
  const mounted = useRailDrawer((s) => s.mounted)
  const setOpen = useRailDrawer((s) => s.setOpen)
  const t = useT()
  if (!mounted) return null
  return (
    <span data-slot="dash-brand" className="flex items-center gap-2 md:hidden">
      <IconButton aria-label={t('ui.showSidebar')} onClick={() => setOpen(true)}>
        <PanelLeftIcon width={16} height={16} />
      </IconButton>
      <a
        href="/"
        aria-label={t('ui.doopHome')}
        className="rounded-control focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
        onClick={(e) => {
          e.preventDefault()
          navigate('/')
        }}
      >
        <Wordmark size="sm" className="text-ink" />
      </a>
    </span>
  )
}

const dashHeaderVariants = cva(
  'flex h-auto min-h-[60px] flex-none flex-wrap items-center gap-2 px-4 py-3 md:h-[60px] md:flex-nowrap md:gap-3 md:px-[26px] md:py-0',
  {
    variants: {
      variant: {
        /* frosted, with a hairline under it */
        default: 'border-b border-line bg-surface/80 backdrop-blur-sm',
        /* no fill and no rule: the bar sits on the page, as on the rail pages */
        bare: 'bg-transparent',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

/** Sticky top bar. It wraps to two rows on a phone, where pages put their
 *  breadcrumb on one line and their actions on the next. The brand row
 *  (DashBrand) leads it on a phone whenever the AppRail is mounted. */
function DashHeader({
  variant,
  className,
  children,
  ...props
}: React.ComponentProps<'header'> & VariantProps<typeof dashHeaderVariants>) {
  return (
    <header
      data-slot="dash-header"
      data-variant={variant ?? 'default'}
      className={cn(dashHeaderVariants({ variant }), className)}
      {...props}
    >
      <DashBrand />
      {children}
    </header>
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
      className={cn('font-sans text-title font-medium tracking-[-0.01em]', className)}
      {...props}
    />
  )
}

function DashSubtitle({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="dash-subtitle"
      className={cn('mt-[7px] text-body leading-[1.45] text-ink-soft md:leading-normal', className)}
      {...props}
    />
  )
}

export {
  DashBrand,
  DashLayout,
  DashSidebar,
  DashSidebarBrand,
  DashSectionLabel,
  DashNavItem,
  DashMain,
  DashHeader,
  DashContent,
  DashTitle,
  DashSubtitle,
}
