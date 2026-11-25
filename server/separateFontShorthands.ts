import { parentPort, workerData } from 'node:worker_threads'
import postcss from 'postcss'

/* Chromium serialises variable and system font shorthands as empty longhands if a later
   declaration overrides part of it. Split the source at the shorthand so the
   declarations keep their cascade order in two rules with the same selector. */
const css = workerData as string
const isConditional = (name: string) => /^(?:media|supports|container|layer|starting-style)$/i.test(name)
const parts: string[] = []
let start = 0
postcss.parse(css).walkDecls(/^font$/i, (font) => {
  const rule = font.parent
  const from = font.source?.start?.offset
  const end = font.source?.end?.offset
  if (!rule || from === undefined || end === undefined || css[end - 1] !== ';') return
  if (!/var\(/i.test(font.value) && !/^[-\w]+$/.test(font.value)) return
  const later = rule.nodes.slice(rule.index(font) + 1)
  if (!later.some((node) => node.type === 'decl' && /^(?:font-|line-height$)/i.test(node.prop))) return
  if (rule.type === 'rule') {
    parts.push(css.slice(start, end), '}', rule.selector, '{')
  } else if (rule.type === 'atrule' && rule.name.toLowerCase() === 'scope') {
    // Bare declarations target the scope root only when directly inside @scope.
    parts.push(css.slice(start, end), '}@scope ', rule.params, '{')
  } else {
    let enclosing = rule.parent
    if (rule.type !== 'atrule' || !isConditional(rule.name)) return
    while (enclosing?.type === 'atrule' && isConditional(enclosing.name)) enclosing = enclosing.parent
    if (enclosing?.type !== 'rule') return
    // A nested conditional inherits the enclosing selector, including its pseudo-element.
    parts.push(css.slice(start, from), '@media all{', css.slice(from, end), '}')
  }
  start = end
})
parts.push(css.slice(start))
parentPort?.postMessage(parts.join(''))
