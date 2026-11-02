import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'
import { ChevronDownIcon } from './icons'

/* The trigger of a dropdown: what is chosen, then a chevron. `ring` is the
   30px pill a page header wears (the sort order); `quiet` is the 28px text
   row inside a composer or a toolbar (drafts, model), which only fills on
   hover. Wrap it in a DropdownMenuTrigger asChild; it forwards the ref. */
const menuButtonVariants = cva(
  [
    'inline-flex flex-none cursor-pointer items-center text-ink-soft',
    'transition-[background-color,color,box-shadow] duration-normal ease-out-quad',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
    'disabled:pointer-events-none disabled:opacity-50',
  ],
  {
    variants: {
      variant: {
        ring: 'h-[30px] gap-[6px] rounded-control bg-surface px-[10px] text-body shadow-ring hover:shadow-ring-hover',
        quiet: 'h-7 gap-[6px] rounded-row px-1.5 text-label hover:bg-paper-deep hover:text-ink',
      },
    },
    defaultVariants: { variant: 'ring' },
  },
)

type MenuButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof menuButtonVariants> & {
    /** a 14px glyph before the label */
    icon?: React.ReactNode
  }

const MenuButton = React.forwardRef<HTMLButtonElement, MenuButtonProps>(function MenuButton(
  { className, variant, icon, type, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      data-slot="menu-button"
      className={cn(menuButtonVariants({ variant, className }))}
      {...props}
    >
      {icon}
      {children}
      <ChevronDownIcon className="size-3 flex-none text-ink-faint" />
    </button>
  )
})

export { MenuButton, menuButtonVariants }
