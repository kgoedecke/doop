import { describe, expect, it } from 'vitest'
import { localSourceOrigin } from '../shared/sourceCanvas.ts'
import { editSourceTarget, sourceTarget } from '../server/sourceJsx.ts'

const jsx = `export default function Hero() {
  return <h1 data-doop-edit="headline" style={{ color: '#203040', margin: 0 }}>Hello Doop</h1>
}`

describe('source JSX edits', () => {
  it('rewrites only the selected literals and can reread the result', () => {
    const target = sourceTarget('Hero.tsx', jsx, 'headline')!
    expect(target).toMatchObject({ line: 2, text: { value: 'Hello Doop' }, color: { value: '#203040' } })
    const text = 'New { copy } < ok "quoted"'
    const color = '#6080ff'
    const changed = editSourceTarget(jsx, target, { text, color })!
    expect(changed).toBe(jsx.replace('#203040', color).replace('Hello Doop', `{${JSON.stringify(text)}}`))
    expect(sourceTarget('Hero.tsx', changed, 'headline')).toMatchObject({
      text: { value: text },
      color: { value: color },
    })
    expect(sourceTarget('Hero.tsx', changed, 'headline')?.revision).not.toBe(target.revision)
  })

  it('does not rewrite dynamic children, style spreads, or ambiguous markers', () => {
    const dynamic = 'const x = <h1 data-doop-edit="title" style={{ ...theme, color: "#111111" }}>{title}</h1>'
    const target = sourceTarget('Hero.tsx', dynamic, 'title')!
    expect(target.text).toBeUndefined()
    expect(target.color).toBeUndefined()
    expect(editSourceTarget(dynamic, target, { text: 'Do not replace' })).toBeNull()
    expect(sourceTarget('Hero.tsx', jsx + '\nconst x = <div data-doop-edit="headline"/>', 'headline')).toBeNull()
  })

  it('reads and edits text formatted over multiple JSX lines', () => {
    const source = `<h1 data-doop-edit="title">
  Hello
  Doop
</h1>`
    const target = sourceTarget('Hero.tsx', source, 'title')!
    expect(target.text?.value).toBe('Hello Doop')
    expect(editSourceTarget(source, target, { text: 'Goodbye' })).toBe('<h1 data-doop-edit="title">{"Goodbye"}</h1>')
  })

  it('supports only the color field on a self-closing JSX element', () => {
    const source = '<hr data-doop-edit="divider" style={{ color: "#eeeeee" }} />'
    const target = sourceTarget('Hero.tsx', source, 'divider')!
    expect(target.text).toBeUndefined()
    expect(editSourceTarget(source, target, { color: '#aaaaaa' })).toBe(source.replace('#eeeeee', '#aaaaaa'))
  })

  it('accepts only bare HTTP loopback origins for either end of the connection', () => {
    expect(localSourceOrigin('http://localhost:4300/')).toBe('http://localhost:4300')
    expect(localSourceOrigin('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173')
    for (const blocked of [
      'https://localhost:4300',
      'http://0.0.0.0:4300',
      'http://localhost.example.com:4300',
      'http://localhost:4300/a',
      'http://localhost:4300/?secret=1',
      'http://foo@localhost:4300',
    ]) {
      expect(localSourceOrigin(blocked)).toBeNull()
    }
  })
})
