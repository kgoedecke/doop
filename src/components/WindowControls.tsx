import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Pressable } from './ui/pressable'
import { useT } from '../lib/i18n'
import { closeWindow, minimizeWindow, toggleMaximizeWindow, useWindowFrame } from '../lib/windowFrame'

/**
 * Minimize / maximize / close for the Windows shell once the page has
 * replaced the native frame (src/lib/windowFrame.ts); renders nothing
 * anywhere else. Sized and drawn like the Windows 11 caption buttons —
 * 46px wide, full bar height, 10px hairline glyphs — so the window still
 * reads as a Windows window.
 */
export function WindowControls({ className }: { className?: string }) {
  const t = useT()
  const custom = useWindowFrame((s) => s.custom)
  const maximized = useWindowFrame((s) => s.maximized)
  if (!custom) return null
  return (
    <div className={cn('flex flex-none self-stretch', className)}>
      <CaptionButton label={t('shell.windowMinimize')} onClick={minimizeWindow}>
        <path d="M0 5.5h10" />
      </CaptionButton>
      <CaptionButton
        label={t(maximized ? 'shell.windowRestore' : 'shell.windowMaximize')}
        onClick={toggleMaximizeWindow}
      >
        {maximized ? <path d="M.5 2.5h7v7h-7zM2.5 2.5v-2h7v7h-2" /> : <path d="M.5.5h9v9h-9z" />}
      </CaptionButton>
      <CaptionButton
        label={t('shell.windowClose')}
        onClick={closeWindow}
        /* red on hover is how Windows marks Close; the failure red stands in
           for the system's so it follows the theme */
        className="hover:bg-destructive hover:text-white active:bg-destructive/90"
      >
        <path d="M0 0l10 10M10 0L0 10" />
      </CaptionButton>
    </div>
  )
}

function CaptionButton({
  label,
  onClick,
  className,
  children,
}: {
  label: string
  onClick: () => void
  className?: string
  children: ReactNode
}) {
  return (
    <Pressable
      layout="inline"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'w-[46px] cursor-default justify-center text-ink-soft transition-colors hover:bg-ink/[0.06] hover:text-ink active:bg-ink/[0.1]',
        className,
      )}
    >
      <svg viewBox="0 0 10 10" className="size-2.5" fill="none" stroke="currentColor" strokeWidth={1} aria-hidden>
        {children}
      </svg>
    </Pressable>
  )
}
