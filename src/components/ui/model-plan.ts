import { cn } from '@/lib/utils'

/* provider rows: one per model plan, divided rather than boxed — the set-card
   is the container. The connected one carries a green left-edge tint. */
export const planRow = (live: boolean) =>
  cn(
    'flex gap-[14px] border-b border-line-soft px-[22px] py-[18px] last:border-b-0 max-md:gap-3 max-md:px-4 max-md:py-[17px]',
    live && 'bg-[linear-gradient(90deg,rgba(63,156,82,0.05),transparent_40%)]',
  )
export const planMark = (live: boolean) =>
  cn(
    'grid h-9 w-9 flex-none place-items-center rounded-[11px] border border-line bg-paper-deep text-ink',
    live && 'border-black bg-black text-white',
  )
export const planPill = (on: boolean) =>
  cn(
    'rounded-full bg-paper-deep px-[9px] py-[3px] text-[11.5px] font-bold text-ink-faint',
    on && 'bg-[rgba(30,122,76,0.12)] text-[#1a6b43]',
  )
/* the model tiers as chips — the base .chip recipe reshaped into the picker */
export const planAsCode =
  'inline-block rounded-[7px] bg-paper-deep px-[9px] py-[3px] font-mono text-[12.5px] leading-[1.5] text-ink [overflow-wrap:anywhere]'
/* chips left, the row's action right, sharing one line */
export const actionsRow =
  'mt-[18px] flex flex-wrap items-center justify-between gap-5 max-md:flex-col max-md:items-stretch max-md:gap-[10px]'
