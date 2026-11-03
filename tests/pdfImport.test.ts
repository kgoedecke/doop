// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { importPdf, isPdfFile } from '../src/lib/pdfImport'
import { importSvgMarkup } from '../src/lib/svgImport'

const report = new Uint8Array(readFileSync(path.join(import.meta.dirname, 'fixtures/pdf/report.pdf')))

describe('importPdf', () => {
  it('recognises a PDF by type or by name', () => {
    expect(isPdfFile(new File([], 'deck.pdf', { type: 'application/pdf' }))).toBe(true)
    expect(isPdfFile(new File([], 'deck.PDF', { type: '' }))).toBe(true)
    expect(isPdfFile(new File([], 'deck.svg', { type: 'image/svg+xml' }))).toBe(false)
  })

  it('makes one frame per page at the page’s CSS size', async () => {
    const [page, ...rest] = await importPdf(report, 'Report', { importSvg: importSvgMarkup })
    expect(rest).toHaveLength(0)
    expect(page).toMatchObject({ name: 'Report', width: 600, height: 400 })
  })

  it('keeps text editable, in the fonts the PDF embeds', async () => {
    const [page] = await importPdf(report, 'Report', { importSvg: importSvgMarkup })
    const doc = new DOMParser().parseFromString(page!.html, 'text/html')
    const texts = [...doc.querySelectorAll('p[data-doop-drawing="text"]')]
    const heading = texts.find((p) => p.textContent === 'Quarterly report')!
    expect(heading).toBeTruthy()
    expect(heading.getAttribute('style')).toContain("font-family:'pdf-Helvetica-Bold', 'Helvetica', sans-serif;")
    expect(heading.getAttribute('style')).toContain('color:rgb(1 119 211)')
    expect(heading.getAttribute('style')).toMatch(/font-size:28px/)
    expect(heading.getAttribute('style')).toMatch(/left:40px;top:3\d(\.\d+)?px/)
    /* a run per font: the bold figure and the italic word stand alone */
    expect(texts.map((p) => p.textContent)).toEqual(
      expect.arrayContaining(['24%', 'churn', 'fell to a record low. Lorem ipsum dolor sit amet.', 'Get started']),
    )
    const faces = doc.querySelector('style[data-doop-pdf-fonts]')!.textContent!
    for (const family of [
      'pdf-Helvetica-Bold',
      'pdf-Georgia',
      'pdf-Georgia-Bold',
      'pdf-Georgia-Italic',
      'pdf-Helvetica',
    ])
      expect(faces).toContain(`@font-face{font-family:"${family}";src:url(data:font/ttf;base64,`)
  })

  it('turns the artwork into editable layers and leaves no SVG text behind', async () => {
    const [page] = await importPdf(report, 'Report', { importSvg: importSvgMarkup })
    const doc = new DOMParser().parseFromString(page!.html, 'text/html')
    expect(doc.querySelectorAll('[data-doop-drawing="path"]').length).toBeGreaterThanOrEqual(3)
    expect(doc.querySelector('text')).toBeNull()
    expect(doc.body.hasAttribute('data-doop-canvas-element')).toBe(false)
    expect(page!.layers).toBeGreaterThan(0)
    expect(page!.texts).toBe(7)
  })

  it('stops at the page limit', async () => {
    expect(await importPdf(report, 'Report', { importSvg: importSvgMarkup, maxPages: 0 })).toEqual([])
  })
})
