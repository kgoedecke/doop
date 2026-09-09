import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/* A copyable command. `density="rail"` is the squeezed form for the narrow
   dashboard rail, where the command is clipped to one line and the copy button
   does the work — previously an ancestor selector reaching in from the page. */
const codeBlockVariants = cva('relative rounded-[10px] bg-[#17171b] font-mono text-[#e9e9ee]', {
  variants: {
    density: {
      default: 'py-[13px] pl-3.5 pr-11 text-xs leading-[1.55] whitespace-pre-wrap break-all',
      rail: 'overflow-hidden text-ellipsis whitespace-nowrap py-2 pl-[9px] pr-[46px] text-[10.5px] leading-[1.55]',
    },
  },
  defaultVariants: { density: 'default' },
})

function CodeBlock({
  text,
  density,
  className,
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & VariantProps<typeof codeBlockVariants> & { text: string }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <div data-slot="code-block" className={cn(codeBlockVariants({ density, className }))} {...props}>
      {text}
      <button
        type="button"
        className={cn(
          'absolute rounded-[6px] bg-white/[0.08] px-2 py-1 text-[11px] text-[#e9e9ee] transition-colors hover:bg-white/[0.18]',
          density === 'rail' ? 'right-[5px] top-[5px]' : 'right-2 top-2',
        )}
        onClick={() => {
          navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          }, console.error)
        }}
      >
        {copied ? '✓' : 'copy'}
      </button>
    </div>
  )
}

export { CodeBlock, codeBlockVariants }
