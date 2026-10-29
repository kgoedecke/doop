import * as React from 'react'
import type { CSSProperties } from 'react'

import { cn } from '@/lib/utils'
import { AgentIcon } from '../AgentIcon'

/** The one or two letters a person is shown as: first and last initial, the
 *  first two letters of a single name, a middle dot for no name at all. The
 *  account menu, the people rows and the share list all read the same way. */
export function initials(name?: string): string {
  const [first, ...rest] = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!first) return '·'
  const last = rest[rest.length - 1]
  const letters = last ? first.slice(0, 1) + last.slice(0, 1) : first.slice(0, 2)
  return letters.toUpperCase()
}

/* the initials' size follows the disc: 9px on the 24px presence face */
function labelClass(size: number) {
  if (size <= 20) return 'text-[8px]'
  if (size <= 26) return 'text-[9px]'
  if (size <= 30) return 'text-micro'
  if (size < 34) return 'text-caption'
  return 'text-body'
}

export interface AvatarProps extends Omit<React.ComponentProps<'span'>, 'color' | 'children'> {
  name: string
  /** the person's presence colour; their disc is a 22% tint of it */
  color?: string
  kind?: 'user' | 'agent'
  /** `ink`: the account's own face on the dashboard, initials on an ink disc
   *  with no collar, instead of the tint of a presence colour */
  tone?: 'tint' | 'ink'
  /** the disc's diameter in px: 24 in the presence pill, 18 on a canvas card, 28–32 in menus and rows */
  size?: number
  /** an agent at work: the silver ring and the sweeping glaze */
  glaze?: boolean
  /** seconds — a second glazed face alternates with the first */
  glazeDelay?: number
  /** one of an overlapping row */
  stacked?: boolean
  /** replaces the initials (the "+2" overflow disc) */
  children?: React.ReactNode
}

/** Who is here, as one face: a disc on a 2px surface collar. A person is
 *  their initials on a tint of their colour; an agent is its brand mark on
 *  the surface. The same face everywhere — the canvas's presence pill, the
 *  account menu, a card's people row, the share list. */
function Avatar({
  name,
  color = 'var(--ink)',
  kind = 'user',
  tone = 'tint',
  size = 24,
  glaze = false,
  glazeDelay = 0,
  stacked = false,
  className,
  style,
  children,
  ...props
}: AvatarProps) {
  return (
    <span
      data-slot="avatar"
      className={cn(
        'relative z-[1] grid flex-none place-items-center overflow-hidden rounded-full bg-surface font-medium text-ink',
        labelClass(size),
        'shadow-[0_0_0_2px_var(--surface),0_0_0_3px_rgba(0,0,0,0.07)] dark:shadow-[0_0_0_2px_var(--surface),0_0_0_3px_rgba(255,255,255,0.12)]',
        glaze && 'glaze-sweep z-[2] shadow-[0_0_0_2px_var(--surface),0_0_0_3px_var(--glaze-ring)]',
        tone === 'ink' && 'bg-ink text-paper shadow-none dark:shadow-none',
        /* a gentle overlap: the collar still reads as a row, both initials stay legible */
        stacked && (size <= 20 ? '-ml-[3px] first:ml-0' : '-ml-1 first:ml-0'),
        className,
      )}
      style={{
        width: size,
        height: size,
        /* inline, so a text-size class (labelClass, a caller's) cannot merge it away;
           a line box no taller than the type keeps the letter centred in the disc */
        lineHeight: 1,
        ...(kind === 'user' && tone === 'tint'
          ? { background: `color-mix(in srgb, ${color} 22%, var(--surface))` }
          : {}),
        ...(glaze ? ({ '--glaze-delay': `${glazeDelay}s` } as CSSProperties) : {}),
        ...style,
      }}
      {...props}
    >
      {children ?? (kind === 'agent' ? <AgentIcon name={name} size={Math.round(size * 0.58)} /> : initials(name))}
    </span>
  )
}

export interface AvatarPerson {
  id: string
  name: string
  color?: string
}

/** A row of overlapping faces, the first `max` of them and a "+N" disc for
 *  the rest; the whole row's tooltip lists everyone. */
function AvatarStack({
  people,
  max = 3,
  size = 24,
  className,
  ...props
}: Omit<React.ComponentProps<'span'>, 'children'> & { people: AvatarPerson[]; max?: number; size?: number }) {
  if (!people.length) return null
  const shown = people.slice(0, max)
  const extra = people.length - shown.length
  return (
    <span
      data-slot="avatar-stack"
      className={cn('flex flex-none items-center', className)}
      title={people.map((p) => p.name).join(', ')}
      {...props}
    >
      {shown.map((p) => (
        <Avatar key={p.id} size={size} stacked name={p.name} color={p.color} title={p.name} />
      ))}
      {extra > 0 && (
        <Avatar size={size} stacked name={`${extra} more`} color="var(--ink-faint)" title={`${extra} more`}>
          +{extra}
        </Avatar>
      )}
    </span>
  )
}

export { Avatar, AvatarStack }
