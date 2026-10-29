// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { carriedCss, renameInCss, scopeMarkup, withCarriedCss } from '../src/lib/styleCarry'

const page = (head: string, body: string) => `<!doctype html>\n<html><head>${head}</head><body>${body}</body></html>`
/* every carried rule is limited to the moved markup through its scope mark */
const S = (sel: string) => `:is([data-doop-carried-scope="s"], [data-doop-carried-scope="s"] *):is(${sel})`
const ROOT = '[data-doop-carried-scope="s"]'
/* a subject pinned to its place under the root: the path weighs nothing, the
   padding is the weight of the ancestors cut off */
const Q = (subject: string, pads = 1) => `${subject}:where(${ROOT})${':not(.\\0)'.repeat(pads)}`

describe('carriedCss', () => {
  it('keeps the rules that match the subtree, scoped, and drops the rest', () => {
    const css = carriedCss(
      page(
        '<style>.card{padding:8px} .card .title{font-weight:600} .other{color:red} p{margin:0}</style>',
        '<div class="card"><p class="title">x</p></div><section class="other"></section>',
      ),
      '.card',
      's',
    )
    expect(css).toContain(`${S('.card')} {`)
    expect(css).toContain(`${S('.card .title')} {`)
    expect(css).toContain(`${S('p')} {`)
    expect(css).not.toContain('.other')
  })

  it('keeps a rule for a state the parsed subtree cannot be in, the pseudo-element last', () => {
    const css = carriedCss(
      page('<style>.btn:hover{opacity:.8} .btn::after{content:""}</style>', '<a class="btn">x</a>'),
      '.btn',
      's',
    )
    expect(css).toContain(`${S('.btn:hover')} {`)
    expect(css).toContain(`${S('.btn')}::after {`)
  })

  it('keeps group rules around their kept children only', () => {
    const css = carriedCss(
      page('<style>@media (max-width:600px){.card{padding:4px} .other{color:red}}</style>', '<div class="card"></div>'),
      '.card',
      's',
    )
    expect(css).toMatch(/@media \(max-width: ?600px\) \{\s*:is\(/)
    expect(css).toContain(`${S('.card')} {`)
    expect(css).not.toContain('.other')
  })

  it('carries the keyframes, font faces and custom properties the subtree uses', () => {
    const head = `<style>
      :root{--brand:#0177d3;--ink:var(--brand);--unused:red}
      @font-face{font-family:Inter;src:url(inter.woff2)}
      @font-face{font-family:Other;src:url(other.woff2)}
      @keyframes pop{from{opacity:0}}
      @keyframes spin{to{transform:rotate(1turn)}}
      .card{color:var(--ink);animation:pop 1s;font-family:Inter,sans-serif}
    </style>`
    const css = carriedCss(page(head, '<div class="card"></div>'), '.card', 's')
    expect(css).toContain(`${ROOT} {`)
    expect(css).toContain('--brand: #0177d3')
    expect(css).toContain('--ink: var(--brand)')
    expect(css).not.toContain('--unused')
    expect(css).not.toContain(':root')
    expect(css).toContain('@keyframes pop')
    expect(css).not.toContain('@keyframes spin')
    expect(css).toContain('font-family: Inter')
    expect(css).not.toContain('Other')
  })

  it('reads fonts and animations out of shorthands', () => {
    const head = `<style>
      @font-face{font-family:Inter;src:url(inter.woff2)}
      @keyframes pop{from{opacity:0}}
      .card{font:16px/1.4 Inter,sans-serif;animation:1s ease-in-out pop infinite}
    </style>`
    const css = carriedCss(page(head, '<div class="card"></div>'), '.card', 's')
    expect(css).toContain('@font-face')
    expect(css).toContain('@keyframes pop')
  })

  it('finds a custom property an ancestor set, and keeps a definition in its media group', () => {
    const head = `<style>
      .theme{--ink:red}
      :root{--bg:white}
      @media (prefers-color-scheme: dark){:root{--bg:black}}
      .card{color:var(--ink);background:var(--bg)}
    </style>`
    const css = carriedCss(page(head, '<div class="theme"><div class="card"></div></div>'), '.card', 's')
    expect(css).toContain('--ink: red')
    expect(css).toContain('--bg: white')
    expect(css).toMatch(/@media \(prefers-color-scheme: ?dark\) \{\s*\[data-doop-carried-scope="s"\] \{\s*--bg: black/)
    expect(css).not.toContain('.theme')
  })

  it('cuts off the ancestors a selector relied on outside the subtree', () => {
    const head = `<style>
      .wrapper .card{padding:8px}
      .theme > .wrapper .card .title{font-weight:600}
      .card .title, .other{color:red}
      .card:hover .title{color:blue}
    </style>`
    const css = carriedCss(
      page(head, '<div class="theme"><div class="wrapper"><div class="card"><p class="title">x</p></div></div></div>'),
      '.card',
      's',
    )
    /* a cut-down selector keeps the weight of what was cut (`:not(.\\0)` per class) */
    expect(css).toContain(`${S('.card:not(.\\0)')} { padding`)
    expect(css).toContain(`${S('.card .title:not(.\\0):not(.\\0)')} { font-weight`)
    expect(css).toContain(`${S('.card .title')} { color: red`)
    expect(css).toContain(`${S('.card:hover .title')} {`)
    expect(css).not.toContain('.wrapper')
    expect(css).not.toContain('.other')
  })

  it('keeps a cut-down selector ahead of the rules it beat before', () => {
    const head = '<style>.wrapper .card{color:red} .card{color:blue} #app .wrapper > .card::after{content:""}</style>'
    const css = carriedCss(
      page(head, '<div id="app"><div class="wrapper"><div class="card"></div></div></div>'),
      '.card',
      's',
    )
    expect(css).toContain(`${S('.card:not(.\\0)')} { color: red; }`)
    expect(css).toContain(`${S('.card')} { color: blue; }`)
    expect(css).toContain(`${S('.card:not(#\\0):not(.\\0)')}::after {`)
  })

  it('names the matched elements by their place when a cut-down selector would reach more', () => {
    const head = '<style>.wrapper > .card{background:red} .wrapper .title{font-weight:600}</style>'
    const css = carriedCss(
      page(
        head,
        '<div class="wrapper"><div class="card"><p class="title">a</p><div class="card"><p class="title">b</p></div></div></div>',
      ),
      '.wrapper > .card',
      's',
    )
    /* the outer card alone had the background: the root, not every .card */
    expect(css).toContain(`${S(Q('.card'))} { background: red; }`)
    expect(css).not.toContain(':is(.card:not')
    /* both titles had the weight: the suffix matches exactly them */
    expect(css).toContain(`${S('.title:not(.\\0)')} { font-weight: 600; }`)
  })

  it('keeps the state a rule asked for when it names elements by their place', () => {
    const head =
      '<style>.wrapper > .card:hover{background:red} .wrapper > .card::after{content:""} .wrapper > .card:not(:hover){opacity:.5}</style>'
    const css = carriedCss(
      page(head, '<div class="wrapper"><div class="card"><div class="card"></div></div></div>'),
      '.wrapper > .card',
      's',
    )
    expect(css).toContain(`${S(Q('.card:where(:hover)', 2))} { background: red; }`)
    expect(css).toContain(`${S(Q('.card'))}::after {`)
    /* a condition stays whole: the `:hover` inside `:not()` is not lifted out */
    expect(css).toContain(`${S(Q('.card:where(:not(:hover))', 2))} { opacity: .5; }`)
  })

  it('leaves the root’s old sibling position behind, and keeps a descendant’s', () => {
    const head = '<style>.list > .item:nth-child(2){color:red} .list > .item > .dot:first-child{fill:blue}</style>'
    const css = carriedCss(
      page(
        head,
        '<div class="list"><div class="item"></div><div class="item"><i class="dot"></i><i class="dot"></i><div class="item"></div></div></div>',
      ),
      '.list > .item:nth-child(2)',
      's',
    )
    /* the second item is alone once lifted: no :nth-child(2) on its path, but its weight stays */
    expect(css).toContain(`${S(Q('.item', 2))} { color: red; }`)
    expect(css).not.toContain(':nth-child(2)')
    /* the first dot is still the first dot inside it */
    expect(css).toContain(':first-child')
  })

  it('restores the weight of a sibling check resolved off the subject or a kept ancestor', () => {
    const head =
      '<style>.list > .item:nth-child(2){color:red} .item.item{color:blue} .list > .item:nth-child(2) > .title{font-weight:600}</style>'
    const body =
      '<div class="list"><i></i><div class="item"><p class="title">a</p><i></i><div class="item"><p class="title">b</p></div></div></div>'
    const css = carriedCss(page(body ? head : '', body), '.list > .item:nth-child(2)', 's')
    /* red keeps the weight of .list and of :nth-child(2): still ahead of .item.item */
    expect(css).toContain(`${S(`.item:where(${ROOT}):not(.\\0):not(.\\0)`)} { color: red; }`)
    /* the item is the only child once lifted, so the kept ancestor loses its :nth-child(2) but not its weight */
    expect(css).toContain(
      `${S(`.item > .title:where(${ROOT} > :nth-child(1)):not(.\\0):not(.\\0)`)} { font-weight: 600; }`,
    )
  })

  it('keeps a rule’s exact priority when resolving a condition changes its shape', () => {
    const head = '<style>.wrapper > :is(:nth-child(2), div){color:red} .a.a{color:blue}</style>'
    const css = carriedCss(
      page(head, '<div class="wrapper"><div class="a"><div class="a"></div></div></div>'),
      '.wrapper > :is(:nth-child(2), div)',
      's',
    )
    /* :is(div) would weigh a type; wrapped in :where() it weighs nothing, and the original class weight is restored: still (0,2,0), still behind .a.a */
    expect(css).toContain(`${S(Q(':where(:is(div))', 2))} { color: red; }`)
  })

  it('resolves the old position out of a condition without losing the rest of it', () => {
    const head = `<style>
      .wrapper > .card:not(:first-child, :hover){opacity:.5}
      .wrapper > .card:is(:nth-child(2), .never){color:red}
      .wrapper > .card:is(:first-child, :hover){color:blue}
    </style>`
    const css = carriedCss(
      page(head, '<div class="wrapper"><i></i><div class="card"><i></i><div class="card"></div></div></div>'),
      '.wrapper > .card:not(:first-child, :hover)',
      's',
    )
    expect(css).toContain(`${S(Q('.card:where(:not(:hover))', 2))} { opacity: .5; }`)
    /* the root was the second child, so that :is() was satisfied outright; its weight stays */
    expect(css).toContain(`${S(Q('.card', 2))} { color: red; }`)
    /* it was not the first child, so only the hover arm is left to ask */
    expect(css).toContain(`${S(Q('.card:where(:is(:hover))', 2))} { color: blue; }`)
    expect(css).not.toContain(':first-child')
    expect(css).not.toContain(':nth-child')
  })

  it('keeps the static checks inside a functional pseudo-class when reading it state-free', () => {
    const head = `<style>
      .wrapper:is(.special:hover) > .card{color:red}
      .wrapper:has(.flag:hover) > .card{color:green}
      .card:is(.card:hover){color:blue}
      .card:has(> :hover){color:gold}
    </style>`
    const css = carriedCss(page(head, '<div class="wrapper"><div class="card"><i></i></div></div>'), '.card', 's')
    /* no .special, no .flag: neither rule could ever apply to this card */
    expect(css).not.toContain('color: red')
    expect(css).not.toContain('color: green')
    /* a hovered card, a hovered child: both can happen, and are the card's own to ask */
    expect(css).toContain('color: blue')
    expect(css).toContain('color: gold')
  })

  it('leaves behind a rule whose condition sat on an ancestor that is not coming along', () => {
    const head =
      '<style>.wrapper:hover > .card{opacity:0} .wrapper:focus-within .card{color:red} .wrapper > .card{color:blue}</style>'
    const css = carriedCss(page(head, '<div class="wrapper"><div class="card"></div></div>'), '.card', 's')
    expect(css).not.toContain('opacity')
    expect(css).not.toContain('color: red')
    expect(css).toContain('color: blue')
  })

  it('keeps a state on an ancestor that moves along, pinning only the subject', () => {
    const head = '<style>.wrapper > .card:hover > .title{color:red}</style>'
    const css = carriedCss(
      page(
        head,
        '<div class="wrapper"><div class="card"><p class="title">a</p><div class="card"><p class="title">b</p></div></div></div>',
      ),
      '.wrapper > .card',
      's',
    )
    /* the card is the moved root and can still be hovered; the title is named by its place */
    expect(css).toContain(
      `${S(`.card:where(:hover) > .title:where(${ROOT} > :nth-child(1)):not(.\\0):not(.\\0)`)} { color: red; }`,
    )
  })

  it('leaves a nested layer’s earlier mark alone when its group moves again', () => {
    const head = `<style data-doop-carried="">:is([data-doop-carried-scope="kid"], [data-doop-carried-scope="kid"] *):is(.kid:where([data-doop-carried-scope="kid"])) { color: red; }</style>`
    const css = carriedCss(
      page(
        head,
        '<div class="group" data-doop-carried-scope="old"><div class="kid" data-doop-carried-scope="kid"></div></div>',
      ),
      '.group',
      's',
    )
    expect(css).toContain('.kid:where([data-doop-carried-scope="kid"])')
    expect(css).not.toContain('.kid:where([data-doop-carried-scope="s"])')
  })

  it('pins a rule an earlier move pinned to its mark to the new mark', () => {
    const head = `<style data-doop-carried="">:is([data-doop-carried-scope="old"], [data-doop-carried-scope="old"] *):is(:where([data-doop-carried-scope="old"]):not(.\\0)) { background: red; }</style>`
    const css = carriedCss(
      page(head, '<div class="card" data-doop-carried-scope="old"><div class="card"></div></div>'),
      '.card',
      's',
    )
    expect(css).toContain(`${S(`:where(${ROOT}):not(.\\0)`)} { background: red; }`)
    expect(css).not.toContain('old')
  })

  it('keeps a rule about a hovered child, reading its state-only compound as any element', () => {
    const head =
      '<style>.card:has(> :hover){outline:1px solid} .card :hover{color:red} .card > :focus-within + i{color:blue}</style>'
    const css = carriedCss(page(head, '<div class="card"><p></p><i></i></div>'), '.card', 's')
    expect(css).toContain(`${S('.card:has(> :hover)')} {`)
    expect(css).toContain(`${S('.card :hover')} {`)
    expect(css).toContain(`${S('.card > :focus-within + i')} {`)
  })

  it('weighs a functional pseudo-class by its most specific argument', () => {
    const head = '<style>.wrapper:is(:not(.absent), #app) > .card{color:red} .card.card.card.card{color:blue}</style>'
    const css = carriedCss(page(head, '<div id="app" class="wrapper"><div class="card"></div></div>'), '.card', 's')
    /* the cut ancestor carried an id's weight through :is(): the red rule keeps beating the blue one */
    expect(css).toContain(`${S('.card:not(#\\0):not(.\\0)')} { color: red; }`)
    expect(css).toContain(`${S('.card.card.card.card')} { color: blue; }`)
  })

  it('reads an escaped colon as part of a class name', () => {
    const head = '<style>.wrapper > .sm\\:block{display:block}</style>'
    const css = carriedCss(
      page(head, '<div class="wrapper"><div class="sm:block"><div class="sm:block"></div></div></div>'),
      '.wrapper > .sm\\:block',
      's',
    )
    expect(css).toContain(`${S(Q('.sm\\:block'))} { display: block; }`)
    expect(css).not.toMatch(/[^\\\\]:block/)
  })

  it('lets the nearest ancestor’s custom property win, as it did in the source', () => {
    const head = '<style>body{--ink:blue} .theme{--ink:red} .outer{--ink:green} .card{color:var(--ink)}</style>'
    const css = carriedCss(
      page(head, '<div class="outer"><div class="theme"><div class="card"></div></div></div>'),
      '.card',
      's',
    )
    const block = /\[data-doop-carried-scope="s"\] \{([^}]*)\}/.exec(css)![1]!
    const order = [...block.matchAll(/--ink: (\w+);/g)].map((m) => m[1])
    expect(order).toEqual(['blue', 'green', 'red'])
  })

  it('follows a custom property into the font and animation it names', () => {
    const head = `<style>
      :root{--anim:pop;--font:Inter}
      @keyframes pop{from{opacity:0}}
      @keyframes spin{to{rotate:1turn}}
      @font-face{font-family:Inter;src:url(i.woff2)}
      @font-face{font-family:Other;src:url(o.woff2)}
      .card{animation:var(--anim) 1s;font-family:var(--font),sans-serif}
    </style>`
    const css = carriedCss(page(head, '<div class="card"></div>'), '.card', 's')
    expect(css).toContain('@keyframes pop')
    expect(css).not.toContain('@keyframes spin')
    expect(css).toContain('font-family: Inter')
    expect(css).not.toContain('Other')
  })

  it('reads a nested style rule with its parent', () => {
    /* happy-dom drops nested rules on parsing, so the sheet is stood in for */
    const nested = {
      selectorText: '& > .card',
      cssText: '& > .card { color: red; }',
      style: { cssText: 'color: red;' },
      cssRules: [],
    }
    const parent = {
      selectorText: '.wrapper, .other',
      cssText: '.wrapper, .other { padding: 4px; & > .card { color: red; } }',
      style: { cssText: 'padding: 4px;' },
      cssRules: [nested],
    }
    const Real = globalThis.CSSStyleSheet
    class Fake {
      cssRules = [parent]
      replaceSync() {}
    }
    globalThis.CSSStyleSheet = Fake as unknown as typeof CSSStyleSheet
    try {
      const css = carriedCss(
        page('<style>x</style>', '<div class="wrapper"><div class="card"></div></div>'),
        '.card',
        's',
      )
      expect(css).toContain(`${S('.card:not(.\\0)')} { color: red; }`)
      expect(css).not.toContain('padding')
    } finally {
      globalThis.CSSStyleSheet = Real
    }
  })

  it('leaves a universal reset and root rules behind, apart from the properties read', () => {
    const css = carriedCss(
      page(
        '<style>*{margin:0;box-sizing:border-box} body{font-family:Inter;--pad:8px} .card{padding:var(--pad)}</style>',
        '<div class="card"></div>',
      ),
      '.card',
      's',
    )
    expect(css).not.toContain('box-sizing')
    expect(css).not.toContain('font-family')
    expect(css).toContain('--pad: 8px')
    expect(css).toContain(`${S('.card')} {`)
  })

  it('is empty when nothing styles the subtree', () => {
    expect(carriedCss(page('<style>.other{color:red}</style>', '<p>x</p>'), 'p', 's')).toBe('')
  })
})

describe('scopeMarkup and renameInCss', () => {
  it('marks each top-level element and follows renamed ids', () => {
    expect(scopeMarkup('<p id="a">x</p><b>y</b>', 's')).toBe(
      '<p id="a" data-doop-carried-scope="s">x</p><b data-doop-carried-scope="s">y</b>',
    )
    expect(renameInCss('#hero { color: red; } .x { fill: url(#hero); } #other {}', { hero: 'hero-copy' })).toBe(
      '#hero-copy { color: red; } .x { fill: url(#hero-copy); } #other {}',
    )
  })

  it('leaves colours alone when an id looks like one', () => {
    expect(
      renameInCss('#abc { --ink: #abc; color: #abc; } @media (x) { #abc { fill: url(#abc) } }', { abc: 'abc-copy' }),
    ).toBe('#abc-copy { --ink: #abc; color: #abc; } @media (x) { #abc-copy { fill: url(#abc-copy) } }')
  })
})

describe('carriedCss on a layer moved before', () => {
  it('takes only the rules of the move that brought this layer in, not another layer’s', () => {
    const head = `<style data-doop-carried>
      [data-doop-carried-scope="red"] { --ink: red; }
      :is([data-doop-carried-scope="red"], [data-doop-carried-scope="red"] *):is(.card) { color: var(--ink); }
      [data-doop-carried-scope="blue"] { --ink: blue; }
      :is([data-doop-carried-scope="blue"], [data-doop-carried-scope="blue"] *):is(.card) { color: blue; }
    </style>`
    const body =
      '<div class="card" data-doop-carried-scope="red"></div><div class="card" data-doop-carried-scope="blue"></div>'
    const css = carriedCss(page(head, body), '[data-doop-carried-scope="red"]', 's')
    expect(css).toContain('color: var(--ink)')
    expect(css).toContain('--ink: red')
    expect(css).not.toContain('blue')
  })

  it('scopes the carried rules once, under the new mark only', () => {
    const head = `<style data-doop-carried>
      [data-doop-carried-scope="old"] { --ink: red; }
      :is([data-doop-carried-scope="old"], [data-doop-carried-scope="old"] *):is(.card) { color: var(--ink); }
      :is([data-doop-carried-scope="old"], [data-doop-carried-scope="old"] *):is(.card)::after { content: ""; }
    </style>`
    const css = carriedCss(page(head, '<div class="card" data-doop-carried-scope="old"></div>'), '.card', 's')
    expect(css).toContain(`${S('.card')} {`)
    expect(css).toContain(`${S('.card')}::after {`)
    expect(css).not.toContain('old')
    expect(css).toContain(`${ROOT} {\n  --ink: red;`)
  })
})

describe('withCarriedCss', () => {
  it('renames a carried animation the destination already defines, in the sheet and the markup', () => {
    const dest = page(
      '<style>@keyframes pop{from{opacity:1}}</style>',
      '<div data-doop-carried-scope="s" style="animation: pop 1s"><i style="animation-name: pop, spin"></i></div>',
    )
    const css =
      '@keyframes pop { from { opacity: 0; } }\n@keyframes spin { to { rotate: 1turn; } }\n.x { animation: 1s ease pop infinite; }'
    const out = withCarriedCss(dest, css, 's')
    expect(out).toContain('@keyframes pop-s {')
    expect(out).toContain('@keyframes spin {')
    expect(out).toContain('animation: 1s ease pop-s infinite')
    expect(out).toContain('style="animation: pop-s 1s"')
    expect(out).toContain('style="animation-name: pop-s, spin"')
    expect(out).toContain('@keyframes pop{from{opacity:1}}')
  })

  it('renames a carried font face the destination already defines, in the sheet and the markup', () => {
    const dest = page(
      '<style>@font-face{font-family:Inter;src:url(theirs.woff2)}</style>',
      '<p data-doop-carried-scope="s" style="font-family: Inter, serif"><i style="font: 12px/1 \'Inter\'"></i></p>',
    )
    const css =
      '@font-face { font-family: Inter; src: url(mine.woff2); }\n.x { font-family: "Inter", sans-serif; }\n.y { font: 1em Inter; }'
    const out = withCarriedCss(dest, css, 's')
    expect(out).toContain('@font-face { font-family: Inter-s; src: url(mine.woff2); }')
    expect(out).toContain('.x { font-family: "Inter-s", sans-serif; }')
    expect(out).toContain('.y { font: 1em Inter-s; }')
    expect(out).toContain('style="font-family: Inter-s, serif"')
    expect(out).toContain(`style="font: 12px/1 'Inter-s'"`)
    expect(out).toContain('@font-face{font-family:Inter;src:url(theirs.woff2)}')
  })

  it('renames a family kept in a custom property along with the face', () => {
    const dest = page(
      '<style>@font-face{font-family:Inter;src:url(theirs.woff2)}</style>',
      '<p data-doop-carried-scope="s"></p>',
    )
    const css =
      '@font-face { font-family: Inter; src: url(mine.woff2); }\n[data-doop-carried-scope="s"] { --type: Inter; }\n.x { font-family: var(--type); }'
    const out = withCarriedCss(dest, css, 's')
    expect(out).toContain('--type: Inter-s;')
    expect(out).toContain('font-family: Inter-s;')
  })

  it('leaves a custom property alone when a font clash renames a family it happens to share', () => {
    const dest = page(
      '<style>@font-face{font-family:Inter;src:url(theirs.woff2)}</style>',
      '<p data-doop-carried-scope="s"></p>',
    )
    const css =
      '@font-face { font-family: Inter; src: url(mine.woff2); }\n@keyframes Inter { to { opacity: 0; } }\n[data-doop-carried-scope="s"] { --anim: Inter; --type: Inter; }\n.x { font-family: var(--type); animation: var(--anim) 1s; }'
    const out = withCarriedCss(dest, css, 's')
    expect(out).toContain('--type: Inter-s;')
    expect(out).toContain('--anim: Inter;')
    expect(out).toContain('@keyframes Inter {')
  })

  it('serves every scope given from one sheet', () => {
    const dest = page(
      '<style>@keyframes pop{from{opacity:1}}</style>',
      '<p data-doop-carried-scope="a" style="animation: pop 1s"></p><p data-doop-carried-scope="b" style="animation: pop 2s"></p>',
    )
    const out = withCarriedCss(dest, '@keyframes pop { to { opacity: 0; } }', ['a', 'b'])
    expect(out.match(/<style data-doop-carried/g)).toHaveLength(1)
    expect(out.match(/animation: pop-a/g)).toHaveLength(2)
  })

  it('rewrites inline animations under every root that wears the scope', () => {
    const dest = page(
      '<style>@keyframes pop{from{opacity:1}}</style>',
      '<p data-doop-carried-scope="s" style="animation: pop 1s"></p><p data-doop-carried-scope="s" style="animation: pop 2s"></p>',
    )
    const out = withCarriedCss(dest, '@keyframes pop { to { opacity: 0; } }', 's')
    expect(out.match(/animation: pop-s/g)).toHaveLength(2)
  })

  it('adds the sheet to the head once', () => {
    const dest = page('', '<div></div>')
    const once = withCarriedCss(dest, '.card { padding: 8px; }')
    expect(once).toContain('<style data-doop-carried="">.card { padding: 8px; }</style>')
    expect(withCarriedCss(once, '.card { padding: 8px; }')).toBe(once)
    expect(withCarriedCss(dest, '')).toBe(dest)
  })
})
