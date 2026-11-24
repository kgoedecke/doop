import { Fragment, useMemo, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { parseMarkdown, type Block, type Inline } from '@/lib/markdown'
import { CodeBlock } from './ui/code-block'

/* An agent's markdown answer, drawn in the surrounding text's size and colour. */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source])
  return (
    <div className={cn('flex min-w-0 flex-col gap-2 break-words', className)}>
      {blocks.map((block, i) => (
        <MarkdownBlock key={i} block={block} />
      ))}
    </div>
  )
}

function MarkdownBlock({ block }: { block: Block }) {
  switch (block.kind) {
    case 'heading':
      return (
        <p role="heading" aria-level={block.level} className="font-medium text-ink">
          {renderInline(block.children)}
        </p>
      )
    case 'list': {
      const List = block.ordered ? 'ol' : 'ul'
      return (
        <List
          start={block.ordered && block.start !== 1 ? block.start : undefined}
          className={cn('flex flex-col gap-1 pl-4', block.ordered ? 'list-decimal' : 'list-disc')}
        >
          {block.items.map((item, i) => (
            <li key={i} className="pl-0.5 marker:text-ink-faint">
              {renderInline(item)}
            </li>
          ))}
        </List>
      )
    }
    case 'code':
      return <CodeBlock text={block.text} />
    case 'paragraph':
      return (
        <p>
          {block.lines.map((line, i) => (
            <Fragment key={i}>
              {i > 0 && <br />}
              {renderInline(line)}
            </Fragment>
          ))}
        </p>
      )
  }
}

function renderInline(spans: Inline[]): ReactNode {
  return spans.map((span, i) => {
    switch (span.kind) {
      case 'text':
        return <Fragment key={i}>{span.text}</Fragment>
      case 'code':
        return (
          <code key={i} className="rounded-tag bg-sub px-1 font-mono text-ink">
            {span.text}
          </code>
        )
      case 'strong':
        return (
          <strong key={i} className="font-medium text-ink">
            {renderInline(span.children)}
          </strong>
        )
      case 'em':
        return <em key={i}>{renderInline(span.children)}</em>
      case 'link':
        return (
          <a
            key={i}
            href={span.href}
            target="_blank"
            rel="noreferrer"
            className="text-brand underline-offset-2 hover:underline"
          >
            {renderInline(span.children)}
          </a>
        )
    }
  })
}
