/** Make partially-revealed HTML paint sensibly. */
export function healPartialHtml(html: string): string {
  // drop a trailing half-written tag: "<div cla"
  const lastOpen = html.lastIndexOf('<')
  if (lastOpen > html.lastIndexOf('>')) html = html.slice(0, lastOpen)
  const lower = html.toLowerCase()
  // drop an unclosed <script> entirely — never run half-written JS
  const scriptAt = lower.lastIndexOf('<script')
  if (scriptAt !== -1 && lower.indexOf('</script', scriptAt) === -1) html = html.slice(0, scriptAt)
  // close an unclosed <style> so everything after it renders
  const styleAt = html.toLowerCase().lastIndexOf('<style')
  if (styleAt !== -1 && html.toLowerCase().indexOf('</style', styleAt) === -1) html += '</style>'
  return html
}
