import { cn } from '@/lib/utils'

/* each dot's offset into the 1.8s twinkle — scattered, so the matrix reads as
   busy rather than as a marching wave */
const DELAYS = [0.9, 0.3, 1.4, 1.1, 0, 0.6, 0.45, 1.6, 0.2]

/** The 3×3 "working" matrix: nine 3px dots twinkling on their own offsets.
 *  It marks something in progress — an agent streaming, a task underway. */
export function DotMatrix({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      data-slot="dot-matrix"
      className={cn('grid w-max flex-none grid-cols-[repeat(3,3px)] gap-[2px]', className)}
    >
      {DELAYS.map((delay, i) => (
        <i
          key={i}
          className="block size-[3px] rounded-full bg-ink-faint opacity-30 animate-[twinkle_1.8s_ease-in-out_infinite] motion-reduce:animate-none"
          style={{ animationDelay: `${delay}s` }}
        />
      ))}
    </span>
  )
}
