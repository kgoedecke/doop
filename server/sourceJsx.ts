import { createHash } from 'node:crypto'
import ts from 'typescript'
import { sourceColor, sourceText } from '../shared/sourceCanvas.ts'

type Literal = { value: string; start: number; end: number }
type Target = { line: number; revision: string; text?: Literal; color?: Literal }

function literal(node: ts.Node, document: ts.SourceFile, value: string): Literal {
  return { value, start: node.getStart(document), end: node.end }
}

function renderedJsxText(source: string) {
  const lines = source.split(/\r\n?|\n/)
  return lines
    .map((line, index) => {
      const spaces = line.replace(/\t/g, ' ')
      const start = index === 0 ? spaces : spaces.trimStart()
      return index === lines.length - 1 ? start : start.trimEnd()
    })
    .filter((line) => line.trim())
    .join(' ')
}

export function sourceTarget(file: string, source: string, marker: string): Target | null {
  const document = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const matches: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = []
  let marked = 0
  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attributes = node.attributes.properties
      if (
        attributes.some(
          (attr) =>
            ts.isJsxAttribute(attr) &&
            attr.name.getText(document) === 'data-doop-edit' &&
            attr.initializer &&
            ts.isStringLiteral(attr.initializer) &&
            attr.initializer.text === marker,
        )
      ) {
        marked++
        if (ts.isIdentifier(node.tagName) && /^[a-z]/.test(node.tagName.text)) {
          matches.push(node)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(document)
  const element = matches[0]
  if (marked !== 1 || !element) return null
  if (ts.isJsxOpeningElement(element) && !element.parent.closingElement.tagName.getText(document)) return null
  const attrs = element.attributes.properties
  if (attrs.some(ts.isJsxSpreadAttribute)) return null
  const target: Target = {
    line: document.getLineAndCharacterOfPosition(element.getStart(document)).line + 1,
    revision: createHash('sha256').update(source).digest('hex'),
  }
  const children = ts.isJsxOpeningElement(element) ? element.parent.children : []
  const child = children.length === 1 ? children[0] : null
  if (child && ts.isJsxText(child) && !child.getFullText(document).includes('&')) {
    const value = renderedJsxText(child.getFullText(document))
    if (value && sourceText.safeParse(value).success) {
      target.text = { value, start: child.getFullStart(), end: child.end }
    }
  } else if (child && ts.isJsxExpression(child) && child.expression && ts.isStringLiteral(child.expression)) {
    if (sourceText.safeParse(child.expression.text).success)
      target.text = literal(child, document, child.expression.text)
  }
  const styles = attrs.filter(
    (attr): attr is ts.JsxAttribute => ts.isJsxAttribute(attr) && attr.name.getText(document) === 'style',
  )
  const style = styles.length === 1 ? styles[0]?.initializer : undefined
  const value = style && ts.isJsxExpression(style) ? style.expression : undefined
  if (
    value &&
    ts.isObjectLiteralExpression(value) &&
    value.properties.every((prop) => ts.isPropertyAssignment(prop) && !ts.isComputedPropertyName(prop.name))
  ) {
    const colors = value.properties.filter((prop): prop is ts.PropertyAssignment => {
      if (!ts.isPropertyAssignment(prop)) return false
      const name = prop.name
      return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === 'color'
    })
    const color = colors[0]?.initializer
    if (colors.length === 1 && color && ts.isStringLiteral(color) && sourceColor.safeParse(color.text).success) {
      target.color = literal(color, document, color.text)
    }
  }
  return target
}

export function editSourceTarget(source: string, target: Target, fields: { text?: string; color?: string }) {
  if ((fields.text !== undefined && !target.text) || (fields.color !== undefined && !target.color)) return null
  const changes = []
  if (fields.text !== undefined && target.text && fields.text !== target.text.value) {
    changes.push({ ...target.text, replacement: '{' + JSON.stringify(fields.text) + '}' })
  }
  if (fields.color !== undefined && target.color && fields.color !== target.color.value) {
    const quote = source[target.color.start] === "'" ? "'" : '"'
    changes.push({ ...target.color, replacement: quote + fields.color + quote })
  }
  let updated = source
  for (const { start, end, replacement } of changes.sort((a, b) => b.start - a.start)) {
    updated = updated.slice(0, start) + replacement + updated.slice(end)
  }
  return updated
}
