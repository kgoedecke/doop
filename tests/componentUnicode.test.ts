import { describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
}))

import * as actions from '../server/actions.ts'
import { healPartialHtml } from '../server/actions.ts'
import { blankComponent } from '../server/components.ts'
import { store } from '../server/store.ts'
import { indexOfAscii, lastIndexOfAscii } from '../shared/asciiSearch.ts'
import { COMPONENT_ATTR, INSTANCE_ATTR, USE_TAG } from '../shared/components.ts'
import type { Actor } from '../shared/types.ts'

/* "İ" (U+0130) lowercases to two code units: offsets found in a lowercased copy of a frame
   pointed one character past every match after it (agent reports, 2026-11-11, Turkish UI) */
const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor
const doc = (body: string) => `<!doctype html><html><head><style></style></head><body>${body}</body></html>`

function canvasWithButton() {
  const canvas = store.createCanvas('unicode', 'owner-unicode')
  const def = blankComponent({ name: 'Buton', by: 'Tester' })
  store.saveComponent(canvas.id, def)
  const main = actions.createFrame(canvas.id, { name: 'Buton main', html: '' }, actor)!
  actions.updateFrame(
    main.id,
    { html: doc(`<button ${COMPONENT_ATTR}="${def.id}"><span data-doop-prop="label">Aç</span></button>`) },
    actor,
  )
  return { canvas, def }
}

describe('a frame with a Turkish capital dotted I', () => {
  it('expands every <doop-use>, those after the character included', () => {
    const { canvas, def } = canvasWithButton()
    const page = actions.createFrame(canvas.id, { name: 'Sayfa', html: '' }, actor)!
    actions.updateFrame(
      page.id,
      {
        html: doc(
          '<doop-use component="Buton" label="Önce"></doop-use><p>İş bulma</p>' +
            '<doop-use component="Buton" label="İş emrini aç"></doop-use><doop-use component="Buton" label="İptal"></doop-use>',
        ),
      },
      actor,
    )
    const html = store.getFrame(page.id)!.html
    expect(html).not.toContain(`<${USE_TAG}`)
    expect(html.split(`${INSTANCE_ATTR}="${def.id}"`)).toHaveLength(4)
    expect(html).toContain('İş emrini aç')
    expect(html).toContain('İptal')
    expect(html).not.toContain('&lt;')
  })

  it('drops a half-written script at its start when streaming', () => {
    expect(healPartialHtml('<p>İstanbul</p><script>let a = 1')).toBe('<p>İstanbul</p>')
    expect(healPartialHtml('<p>İstanbul</p><style>p{color:red}')).toBe('<p>İstanbul</p><style>p{color:red}</style>')
  })
})

describe('the ASCII search', () => {
  it('ignores case and gives offsets into the string it was given', () => {
    const text = 'İİ<DOOP-USE x></Doop-Use>'
    expect(indexOfAscii(text, '<doop-use')).toBe(2)
    expect(indexOfAscii(text, '</doop-use')).toBe(text.indexOf('</Doop-Use'))
    expect(lastIndexOfAscii(text, '<doop-use')).toBe(2)
    expect(indexOfAscii(text, '<doop-use', 3)).toBe(-1)
  })
})
