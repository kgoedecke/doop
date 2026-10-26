// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { Canvas, Frame } from '../shared/types'
import {
  flowStartFrame,
  interactionAttributes,
  parseInteractions,
  prototypeLinks,
  scanInteractions,
  type Interaction,
} from '../shared/prototype'
import {
  historyStep,
  protoHistoryState,
  readProtoHistory,
  sanitizeInteraction,
  transitionFrames,
} from '../src/lib/prototypePlayer'
import { elementInteractions, withElementInteractions } from '../src/lib/prototype'

const click = (action: string, extra: Partial<Interaction> = {}): Interaction => ({
  ...parseInteractions({ on: 'click', action })[0]!,
  ...extra,
})

describe('parseInteractions', () => {
  it('reads the single-attribute form with defaults', () => {
    expect(parseInteractions({ on: 'click', action: 'navigate:abc' })).toEqual([
      { trigger: 'click', action: 'navigate', target: 'abc', transition: 'instant', duration: 300 },
    ])
    expect(
      parseInteractions({ on: 'hover', action: 'overlay:menu-1', transition: 'dissolve', duration: '120' }),
    ).toEqual([{ trigger: 'hover', action: 'overlay', target: 'menu-1', transition: 'dissolve', duration: 120 }])
  })

  it('reads delay and key triggers', () => {
    expect(parseInteractions({ on: 'delay:1500', action: 'back' })[0]).toMatchObject({ trigger: 'delay', delay: 1500 })
    expect(parseInteractions({ on: 'key:ArrowRight', action: 'navigate:n2' })[0]).toMatchObject({
      trigger: 'key',
      key: 'ArrowRight',
    })
    expect(parseInteractions({ on: 'key:Space', action: 'back' })[0]).toMatchObject({ key: ' ' })
    expect(parseInteractions({ on: 'press', action: 'close-overlay' })[0]).toMatchObject({
      trigger: 'press',
      action: 'close-overlay',
    })
  })

  it('reads the JSON form after the single form', () => {
    const list = parseInteractions({
      on: 'click',
      action: 'navigate:a',
      interactions: JSON.stringify([
        { on: 'key:Escape', action: 'back' },
        { on: 'delay:200', action: 'scroll-to:#pricing', transition: 'slide-left', duration: 50 },
      ]),
    })
    expect(list.map((i) => [i.trigger, i.action, i.target])).toEqual([
      ['click', 'navigate', 'a'],
      ['key', 'back', undefined],
      ['delay', 'scroll-to', '#pricing'],
    ])
    expect(list[2]).toMatchObject({ transition: 'slide-left', duration: 50 })
  })

  it('ignores invalid entries and values', () => {
    expect(parseInteractions({ on: 'dblclick', action: 'back' })).toEqual([])
    expect(parseInteractions({ on: 'click', action: 'teleport:x' })).toEqual([])
    expect(parseInteractions({ on: 'click', action: 'navigate:' })).toEqual([])
    expect(parseInteractions({ on: 'click', action: 'navigate:bad id!' })).toEqual([])
    expect(parseInteractions({ on: 'click' })).toEqual([])
    expect(parseInteractions({ interactions: 'not json' })).toEqual([])
    expect(
      parseInteractions({ interactions: '[1, null, {"on":"click"}, {"on":"click","action":"back"}]' }),
    ).toHaveLength(1)
    /* an unknown transition or a bad duration falls back to the defaults */
    expect(parseInteractions({ on: 'click', action: 'back', transition: 'spin', duration: '-5' })[0]).toMatchObject({
      transition: 'instant',
      duration: 300,
    })
    expect(parseInteractions({ on: 'click', action: 'back', duration: '999999' })[0]!.duration).toBe(5000)
  })

  it('allows only http and https links', () => {
    expect(parseInteractions({ on: 'click', action: 'url:https://doop.design/docs' })[0]).toMatchObject({
      action: 'url',
      target: 'https://doop.design/docs',
    })
    expect(parseInteractions({ on: 'click', action: 'url:http://example.com' })).toHaveLength(1)
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com', 'file:///etc/passwd', 'nope'])
      expect(parseInteractions({ on: 'click', action: `url:${bad}` })).toEqual([])
  })

  it('is self-contained, so the frame runtime can inline its source', () => {
    const inlined = new Function(`return (${parseInteractions.toString()})`)() as typeof parseInteractions
    const attrs = {
      on: 'click',
      action: 'url:https://example.com',
      interactions: '[{"on":"key:Space","action":"overlay:o1","transition":"push-left"}]',
    }
    expect(inlined(attrs)).toEqual(parseInteractions(attrs))
  })
})

describe('interactionAttributes', () => {
  it('writes one interaction as single attributes and clears the JSON form', () => {
    expect(interactionAttributes([click('navigate:abc', { transition: 'dissolve' })])).toEqual({
      'data-doop-on': 'click',
      'data-doop-action': 'navigate:abc',
      'data-doop-transition': 'dissolve',
      'data-doop-duration': null,
      'data-doop-interactions': null,
    })
  })

  it('writes several as JSON that parses back to the same list', () => {
    const list = [click('navigate:a'), { ...click('back'), trigger: 'key' as const, key: ' ' }]
    const attrs = interactionAttributes(list)
    expect(attrs['data-doop-on']).toBeNull()
    expect(parseInteractions({ interactions: attrs['data-doop-interactions'] })).toEqual(list)
  })

  it('clears every attribute for no interactions', () => {
    expect(Object.values(interactionAttributes([]))).toEqual([null, null, null, null, null])
  })
})

describe('scanInteractions', () => {
  it('finds interactive elements in raw HTML, decoding entities and skipping scripts', () => {
    const html = `<!doctype html><body>
      <button id="go" data-doop-on="click" data-doop-action="navigate:f2">Go</button>
      <a class="cta big" data-doop-interactions="[{&quot;on&quot;:&quot;hover&quot;,&quot;action&quot;:&quot;overlay:f3&quot;}]">Menu &gt;</a>
      <div data-doop-on='key:Escape' data-doop-action=back>x</div>
      <script>const s = '<p data-doop-on="click" data-doop-action="back">'</script>
      <p data-doop-on="click" data-doop-action="url:javascript:alert(1)">bad</p>
    </body>`
    const found = scanInteractions(html)
    expect(found.map((f) => f.label)).toEqual(['#go', '"Menu >"', '"x"', '"bad"'])
    expect(found[1]!.interactions[0]).toMatchObject({ trigger: 'hover', action: 'overlay', target: 'f3' })
    expect(found[2]!.interactions[0]).toMatchObject({ trigger: 'key', key: 'Escape', action: 'back' })
    expect(found[3]!.interactions).toEqual([])
  })

  it('skips script and style bodies whatever the letter case of their tags', () => {
    const html = `<body>
      <SCRIPT type="text/x-template"><button data-doop-on="click" data-doop-action="back">in a script</button></script>
      <Style>/* <a data-doop-on="click" data-doop-action="back"> */</STYLE>
      <script-host data-doop-on="click" data-doop-action="back">custom</script-host>
      <BUTTON ID="real" data-doop-on="click" data-doop-action="back">Real</BUTTON>
    </body>`
    expect(scanInteractions(html).map((f) => f.label)).toEqual(['"custom"', '#real'])
  })
})

const frame = (id: string, x: number, y: number, html = '<p>hi</p>', pageId = 'p1'): Frame => ({
  id,
  canvasId: 'c',
  pageId,
  name: id.toUpperCase(),
  x,
  y,
  width: 100,
  height: 100,
  html,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Test',
})

describe('flows and targets', () => {
  const canvas: Canvas = {
    id: 'c',
    name: 'C',
    pages: [{ id: 'p1', name: 'One' }],
    frames: [
      frame('b', 200, 0, '<button data-doop-on="click" data-doop-action="navigate:a">A</button>'),
      frame('a', 0, 0, '<i data-doop-on="click" data-doop-action="overlay:gone">?</i>'),
    ],
    createdAt: 0,
    updatedAt: 0,
  }

  it('starts on the explicit start frame, else the top-left frame', () => {
    expect(flowStartFrame(canvas, 'p1')?.id).toBe('a')
    expect(flowStartFrame({ ...canvas, pages: [{ id: 'p1', name: 'One', startFrameId: 'b' }] }, 'p1')?.id).toBe('b')
    /* a start frame that was deleted falls back */
    expect(flowStartFrame({ ...canvas, pages: [{ id: 'p1', name: 'One', startFrameId: 'zz' }] }, 'p1')?.id).toBe('a')
  })

  it('flags interactions whose target frame does not exist', () => {
    const links = prototypeLinks(canvas)
    expect(links).toHaveLength(2)
    expect(links[0]).toMatchObject({ fromFrameId: 'b', element: '"A"' })
    expect(links[0]!.problem).toBeUndefined()
    expect(links[1]!.problem).toContain('gone')
  })
})

describe('editor writes', () => {
  const html = '<!doctype html><html><head></head><body><button>Go</button></body></html>'
  const selector = 'body > button:nth-of-type(1)'

  it('round-trips an element’s interactions through the frame HTML', () => {
    const one = withElementInteractions(html, selector, [click('navigate:f2')])!
    expect(one).toContain('data-doop-on="click"')
    expect(one).toContain('data-doop-action="navigate:f2"')
    expect(elementInteractions(one, selector)).toEqual([click('navigate:f2')])

    const two = withElementInteractions(one, selector, [click('navigate:f2'), click('back')])!
    expect(two).not.toContain('data-doop-on=')
    expect(elementInteractions(two, selector)).toHaveLength(2)

    const none = withElementInteractions(two, selector, [])!
    expect(none).not.toContain('data-doop')
    expect(withElementInteractions(html, 'body > nav', [])).toBeNull()
  })
})

describe('player helpers', () => {
  it('re-validates interactions posted from the sandbox', () => {
    expect(sanitizeInteraction(click('navigate:f2'))).toEqual(click('navigate:f2'))
    expect(sanitizeInteraction({ trigger: 'click', action: 'url', target: 'javascript:alert(1)' })).toBeNull()
    expect(sanitizeInteraction({ trigger: 'click', action: 'navigate', target: '../../x' })).toBeNull()
    expect(sanitizeInteraction('navigate:f2')).toBeNull()
  })

  it('plays Back as the arriving transition reversed', () => {
    const forward = transitionFrames('slide-left', false)
    expect(forward.incoming[0]).toEqual({ transform: 'translate(100%, 0%)' })
    expect(forward.outgoingOnTop).toBe(false)
    const back = transitionFrames('slide-left', true)
    expect(back.outgoing.at(-1)).toEqual({ transform: 'translate(100%, 0%)' })
    expect(back.outgoingOnTop).toBe(true)
    const push = transitionFrames('push-right', false)
    expect(push.outgoing.at(-1)).toEqual({ transform: 'translate(100%, 0%)' })
    expect(transitionFrames('instant', false).incoming).toEqual([])
  })

  it('tells repeated screens in the browser history apart by depth', () => {
    const stack = [
      { frameId: 'a', depth: 0 },
      { frameId: 'b', depth: 1 },
      { frameId: 'a', depth: 2 },
    ]
    expect(historyStep(stack, { frameId: 'a', depth: 2 })).toBe('none')
    expect(historyStep(stack, { frameId: 'b', depth: 1 })).toBe('back')
    /* Forward onto a screen seen earlier is a step forward, not a Back */
    expect(historyStep(stack.slice(0, 2), { frameId: 'a', depth: 2 })).toBe('jump')
    expect(historyStep(stack.slice(0, 1), { frameId: 'b', depth: 1 })).toBe('jump')
    expect(historyStep(stack, { frameId: 'a', depth: 0 })).toBe('jump')
  })

  it('reads back only the history entries the player wrote', () => {
    expect(readProtoHistory(protoHistoryState('a', 0))).toEqual({ frameId: 'a', depth: 0 })
    expect(readProtoHistory(null)).toBeNull()
    expect(readProtoHistory({ doopProto: true })).toBeNull()
    expect(readProtoHistory({ doopProto: true, frameId: 'a', depth: -1 })).toBeNull()
  })
})
