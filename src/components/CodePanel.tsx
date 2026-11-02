import { useEffect, useRef, useState } from 'react'
import { Button } from './ui/button'
import { CheckIcon, ClipboardIcon } from './ui/icons'
import { useT } from '../lib/i18n'

/** Source view for the element toolbar: the selected element's markup with a copy button. */
export function CodePanel({ code }: { code: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current)
    },
    [],
  )

  function copy() {
    navigator.clipboard.writeText(code).then(
      () => {
        if (copyTimer.current !== null) clearTimeout(copyTimer.current)
        setCopied(true)
        copyTimer.current = setTimeout(() => setCopied(false), 1500)
      },
      () => setCopied(false),
    )
  }

  return (
    <div className="mt-1.5 flex w-[440px] max-w-[80vw] items-center gap-2 rounded-pill bg-ink p-1 pl-3 shadow-pop animate-[chip-in_0.18s_ease]">
      <pre
        data-stage-scroll
        className="max-h-[260px] min-w-0 flex-1 overflow-auto whitespace-pre-wrap text-[11px] leading-[1.55] text-paper [font-family:ui-monospace,monospace] [word-break:break-word]"
      >
        {code}
      </pre>
      <Button
        variant="inverse"
        size="icon-sm"
        className="rounded-pill"
        aria-label={copied ? t('inspector.codeCopied') : t('inspector.copyCode')}
        onClick={copy}
      >
        {copied ? <CheckIcon className="text-success-on-ink" /> : <ClipboardIcon />}
      </Button>
      <span role="status" className="sr-only">
        {copied ? t('inspector.codeCopiedStatus') : ''}
      </span>
    </div>
  )
}
