import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/* Doop's modal: a hairline card lifted on the soft pop shadow, over a dimmed
   canvas. Built on Radix so it brings a focus trap, Escape and scroll-locking
   with it — the hand-rolled backdrop divs it replaces had none of that. Call
   sites mount it conditionally, so `open` defaults to true and `onClose` is
   the only dismissal wiring they need. */
const modalVariants = cva(
  [
    'fixed left-1/2 top-1/2 z-[60] w-full -translate-x-1/2 -translate-y-1/2 overflow-y-auto',
    'rounded-[14px] border border-line bg-surface p-5 text-ink shadow-pop',
    'animate-[modal-in_0.2s_cubic-bezier(0.2,0.9,0.3,1.2)] outline-none',
    'max-h-[calc(100dvh-24px)] sm:max-h-[calc(100vh-96px)] sm:rounded-[16px] sm:p-7',
  ],
  {
    variants: {
      size: {
        sm: 'max-w-[min(460px,calc(100vw-24px))]',
        md: 'max-w-[min(520px,calc(100vw-24px))]',
        lg: 'max-w-[min(620px,calc(100vw-24px))] sm:max-w-[660px]',
        xl: 'max-w-[min(760px,calc(100vw-24px))]',
      },
    },
    defaultVariants: { size: 'md' },
  },
)

function Modal({
  open = true,
  onClose,
  size,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof DialogPrimitive.Content>, 'onOpenChange'> &
  VariantProps<typeof modalVariants> & {
    open?: boolean
    onClose: () => void
  }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[60] animate-[fade-in_0.15s_ease] bg-[rgba(18,18,23,0.45)]" />
        <DialogPrimitive.Content data-slot="modal" className={cn(modalVariants({ size, className }))} {...props}>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/** The small mono caption above a modal title. */
function ModalEyebrow({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="modal-eyebrow"
      className={cn(
        'font-mono text-[10px] font-[650] uppercase leading-none tracking-[0.14em] text-accent-ink',
        className,
      )}
      {...props}
    />
  )
}

function ModalTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="modal-title"
      className={cn('font-serif text-[26px] font-normal tracking-[-0.012em] sm:text-[28px]', className)}
      {...props}
    />
  )
}

function ModalLede({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="modal-lede"
      className={cn('mt-2 text-sm leading-[1.55] text-ink-soft', className)}
      {...props}
    />
  )
}

/** Footer action row — buttons go full-width side by side on small phones. */
function ModalActions({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="modal-actions"
      className={cn(
        'mt-[26px] flex flex-wrap justify-end gap-2.5 [&>*]:max-xs:flex-1 [&>*]:max-xs:justify-center',
        className,
      )}
      {...props}
    />
  )
}

/** Pushes the actions after it to the other end of the row. */
function ModalSpacer() {
  return <span data-slot="modal-spacer" className="flex-1" aria-hidden />
}

/** A read-only block of markdown or copy inside a modal. */
function MarkdownBlock({ className, ...props }: React.ComponentProps<'pre'>) {
  return (
    <pre
      data-slot="markdown-block"
      className={cn(
        'mt-3.5 max-h-[52vh] overflow-auto whitespace-pre-wrap rounded-[12px] border border-line bg-paper px-[18px] py-4 font-mono text-[12.5px] leading-[1.65] text-ink [word-break:break-word]',
        className,
      )}
      {...props}
    />
  )
}

export { Modal, ModalEyebrow, ModalTitle, ModalLede, ModalActions, ModalSpacer, MarkdownBlock, modalVariants }
