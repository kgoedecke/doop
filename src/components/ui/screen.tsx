import * as React from 'react'

import { cn } from '@/lib/utils'
import { DashTitle } from './dash'
import { Wordmark } from './wordmark'

/* Full-viewport shell for the signed-out screens: a centred card on paper with
   the brand's warm glow in the top-right. dvh (not vh) so mobile browser chrome
   cannot push the card under the fold, and the padding tightens on small
   screens where 32px of gutter is a third of the width.
   The child centres with `margin: auto` rather than `place-items-center`: auto
   margins give back the leftover space, so a card taller than the screen — a
   phone in landscape, or the sign-up form with its extra field — starts at the
   top and scrolls instead of having its head cut off above the viewport. */
function AuthScreen({ className, children, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="auth-screen"
      className={cn('flex h-dvh min-h-dvh flex-col overflow-y-auto bg-paper px-4 py-5 sm:p-8 [&>*]:m-auto', className)}
      {...props}
    >
      {children}
    </div>
  )
}

/* The one card every signed-out screen shows inside AuthScreen: sign-in, the
   OAuth consent, the desktop hand-offs, a canvas that does not exist. It
   carries the wordmark and the page title (DashTitle, as every page title
   is), so a screen supplies only its title and what goes under it. The
   sign-in form is the card itself (`as="form"`), so its fields keep the
   card's rhythm. */
function AuthCard({
  title,
  as: Element = 'div',
  align = 'start',
  className,
  children,
  ...props
}: Omit<React.HTMLAttributes<HTMLElement>, 'title'> & {
  title: React.ReactNode
  /** `form` when the card is the form, as on the sign-in screen */
  as?: 'div' | 'form'
  /** centred: the wordmark and every line of copy sit on the card's axis */
  align?: 'start' | 'center'
}) {
  return (
    <Element
      data-slot="auth-card"
      className={cn(
        'flex w-[min(400px,100%)] flex-col gap-3.5 rounded-card border border-line bg-surface p-6 pt-[30px] shadow-pop sm:p-9 sm:pb-7',
        align === 'center' && 'text-center',
        className,
      )}
      {...props}
    >
      <Wordmark className={cn('mb-1.5', align === 'center' && 'self-center')} />
      <DashTitle className="break-words">{title}</DashTitle>
      {children}
    </Element>
  )
}

/** The card's prose: what happened, or what the screen is asking. */
function AuthCardText({ className, ...props }: React.ComponentProps<'p'>) {
  return <p data-slot="auth-card-text" className={cn('text-copy text-ink-soft', className)} {...props} />
}

export { AuthScreen, AuthCard, AuthCardText }
