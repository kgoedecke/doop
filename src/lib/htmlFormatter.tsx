import React from 'react'
import { cn } from './utils'

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

/** Formats an HTML string cleanly while safely preserving <script>, <style>, <pre>, and <textarea> blocks verbatim. */
export function formatHtml(html: string): string {
  if (!html) return ''

  const str = html.replace(/\r\n/g, '\n').trim()
  // Regex captures comments, doctypes, raw script/style/pre/textarea blocks, and regular tags
  const tokens = str.split(
    /(<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<pre[\s\S]*?<\/pre>|<textarea[\s\S]*?<\/textarea>|<[^>]+>)/gi,
  )

  let formatted = ''
  let indentLevel = 0
  const indentStr = '  '

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === undefined) continue

    const trimmed = token.trim()
    if (!trimmed) continue

    if (trimmed.startsWith('<')) {
      const lower = trimmed.toLowerCase()
      if (trimmed.startsWith('<!--') || lower.startsWith('<!doctype')) {
        formatted += (formatted ? '\n' : '') + indentStr.repeat(indentLevel) + trimmed
      } else if (
        lower.startsWith('<script') ||
        lower.startsWith('<style') ||
        lower.startsWith('<pre') ||
        lower.startsWith('<textarea')
      ) {
        // Raw block element - preserve inner content without mangling
        formatted += (formatted ? '\n' : '') + indentStr.repeat(indentLevel) + trimmed
      } else if (trimmed.startsWith('</')) {
        indentLevel = Math.max(0, indentLevel - 1)
        formatted += (formatted ? '\n' : '') + indentStr.repeat(indentLevel) + trimmed
      } else {
        const tagNameMatch = trimmed.match(/^<([a-zA-Z0-9:-]+)/)
        const tagName = tagNameMatch && tagNameMatch[1] ? tagNameMatch[1].toLowerCase() : ''
        const isSelfClosing = trimmed.endsWith('/>') || VOID_ELEMENTS.has(tagName)

        formatted += (formatted ? '\n' : '') + indentStr.repeat(indentLevel) + trimmed

        if (!isSelfClosing && tagName) {
          indentLevel++
        }
      }
    } else {
      const lines = trimmed.split('\n')
      for (const line of lines) {
        const l = line.trim()
        if (l) {
          formatted += (formatted ? '\n' : '') + indentStr.repeat(indentLevel) + l
        }
      }
    }
  }

  return formatted || str
}

/** Tokenizes a single HTML line into colored React elements matching Doop dark surface theme. */
function highlightHtmlLine(line: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let pos = 0
  let tokenIdx = 0

  while (pos < line.length) {
    const key = `${keyPrefix}-${tokenIdx++}`

    // Comment
    if (line.slice(pos).startsWith('<!--')) {
      const endComment = line.indexOf('-->', pos)
      const commentText = endComment !== -1 ? line.slice(pos, endComment + 3) : line.slice(pos)
      nodes.push(
        <span key={key} className="italic text-[#787f89]">
          {commentText}
        </span>,
      )
      pos += commentText.length
      continue
    }

    // Doctype
    if (line.slice(pos).toUpperCase().startsWith('<!DOCTYPE')) {
      const endDoctype = line.indexOf('>', pos)
      const doctypeText = endDoctype !== -1 ? line.slice(pos, endDoctype + 1) : line.slice(pos)
      nodes.push(
        <span key={key} className="font-semibold text-[#8b949e]">
          {doctypeText}
        </span>,
      )
      pos += doctypeText.length
      continue
    }

    // Tag opening '<' or '</'
    if (line[pos] === '<') {
      const isClosing = line.slice(pos).startsWith('</')
      const tagStartLen = isClosing ? 2 : 1
      nodes.push(
        <span key={key} className="text-[#8b949e]">
          {isClosing ? '</' : '<'}
        </span>,
      )
      pos += tagStartLen

      // Tag name
      const tagNameMatch = line.slice(pos).match(/^([a-zA-Z0-9:-]+)/)
      if (tagNameMatch && tagNameMatch[1]) {
        const tagName = tagNameMatch[1]
        nodes.push(
          <span key={`${key}-tag`} className="font-semibold text-[#79c0ff]">
            {tagName}
          </span>,
        )
        pos += tagName.length
      }

      // Attributes within tag until '>' or '/>'
      while (pos < line.length && line[pos] !== '>' && !line.slice(pos).startsWith('/>')) {
        const attrKey = `${key}-attr-${tokenIdx++}`

        // Whitespace inside tag
        const wsMatch = line.slice(pos).match(/^(\s+)/)
        if (wsMatch && wsMatch[1]) {
          const ws = wsMatch[1]
          nodes.push(<span key={attrKey}>{ws}</span>)
          pos += ws.length
          continue
        }

        // Attribute name
        const attrNameMatch = line.slice(pos).match(/^([a-zA-Z0-9_:-]+)/)
        if (attrNameMatch && attrNameMatch[1]) {
          const attrName = attrNameMatch[1]
          nodes.push(
            <span key={attrKey} className="text-[#d2a8ff]">
              {attrName}
            </span>,
          )
          pos += attrName.length

          // Equals sign '='
          if (line[pos] === '=') {
            nodes.push(
              <span key={`${attrKey}-eq`} className="text-[#8b949e]">
                =
              </span>,
            )
            pos++

            // Attribute value (quoted string or value)
            const currentChar = line[pos]
            if (currentChar === '"' || currentChar === "'") {
              const quote = currentChar
              const endQuote = line.indexOf(quote, pos + 1)
              const valText = endQuote !== -1 ? line.slice(pos, endQuote + 1) : line.slice(pos)
              nodes.push(
                <span key={`${attrKey}-val`} className="text-[#a5d6ff]">
                  {valText}
                </span>,
              )
              pos += valText.length
            } else {
              const unquotedMatch = line.slice(pos).match(/^([^\s/>]+)/)
              if (unquotedMatch && unquotedMatch[1]) {
                const unquotedVal = unquotedMatch[1]
                nodes.push(
                  <span key={`${attrKey}-val`} className="text-[#a5d6ff]">
                    {unquotedVal}
                  </span>,
                )
                pos += unquotedVal.length
              }
            }
          }
          continue
        }

        // Advance if non-matching char
        const ch = line[pos]
        if (ch) {
          nodes.push(<span key={attrKey}>{ch}</span>)
          pos += ch.length
        } else {
          pos++
        }
      }

      // Closing bracket '>' or '/>'
      if (line.slice(pos).startsWith('/>')) {
        nodes.push(
          <span key={`${key}-close`} className="text-[#8b949e]">
            {'/>'}
          </span>,
        )
        pos += 2
      } else if (line[pos] === '>') {
        nodes.push(
          <span key={`${key}-close`} className="text-[#8b949e]">
            {'>'}
          </span>,
        )
        pos++
      }
      continue
    }

    // Text node content up to next '<'
    const nextTag = line.indexOf('<', pos)
    const textSegment = nextTag !== -1 ? line.slice(pos, nextTag) : line.slice(pos)
    nodes.push(
      <span key={key} className="text-[#e9e9ee]">
        {textSegment}
      </span>,
    )
    pos += textSegment.length
  }

  return nodes
}

/** Component for rendering syntax-highlighted HTML code block with optional line numbers and line wrapping. */
export function HtmlHighlightView({
  code,
  className,
  showLineNumbers = false,
  wrapLines = false,
}: {
  code: string
  className?: string
  showLineNumbers?: boolean
  wrapLines?: boolean
}) {
  const lines = code.split('\n')

  return (
    <pre className={cn('font-mono text-xs leading-[1.65]', className)} style={{ margin: 0 }}>
      <code>
        {lines.map((line, idx) => (
          <div
            key={idx}
            className={cn(
              'line flex min-h-[1.55em] items-start',
              wrapLines ? 'whitespace-pre-wrap break-all' : 'whitespace-pre',
            )}
          >
            {showLineNumbers && (
              <span className="mr-4 inline-block w-9 shrink-0 select-none text-right font-mono text-[11px] text-[#545b64]">
                {idx + 1}
              </span>
            )}
            <span className="flex-1 overflow-x-visible">{highlightHtmlLine(line, `l-${idx}`)}</span>
          </div>
        ))}
      </code>
    </pre>
  )
}
