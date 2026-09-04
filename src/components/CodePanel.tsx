import { useState } from 'react'
import { Button } from './ui/button'

/** Source view for the element toolbar: the selected element's markup with a copy button. */
export function CodePanel({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)

  function copy() {
    navigator.clipboard.writeText(code).then(
      () => setCopied(true),
      () => setCopied(false),
    )
  }

  return (
    <div className="relative mt-1.5 w-[440px] max-w-[80vw] rounded-[10px] bg-ink px-3 py-2.5 shadow-pop animate-[chip-in_0.18s_ease]">
      <Button
        variant="inverse"
        size="sm"
        className="absolute right-2 top-[7px] rounded-md bg-white/[0.12] px-[9px] py-[3px] text-[11px] hover:bg-white/[0.22]"
        onClick={copy}
      >
        {copied ? 'Copied!' : 'Copy'}
      </Button>
      <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap text-[11px] leading-[1.55] text-[#d9e2ec] [font-family:ui-monospace,monospace] [word-break:break-word]">
        {code}
      </pre>
    </div>
  )
}
