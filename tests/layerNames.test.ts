// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { buildLayerTree, layerName } from '../src/lib/layers'
import { ensureInstanceName } from '../shared/designSystem'

const page = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`

describe('layer names', () => {
  it('shows a component instance by its name, with the component glyph and its slug', () => {
    const [node] = buildLayerTree(
      page('<div class="uk-card" data-doop-component="card-pesquisa" data-name="Card de pesquisa"><p>x</p></div>'),
    )
    expect(node).toEqual(
      expect.objectContaining({ label: 'Card de pesquisa', detail: 'card-pesquisa', kind: 'component', named: true }),
    )
    expect(layerName(node!)).toBe('Card de pesquisa')
    expect(node!.children).toHaveLength(1)
  })

  it('titles an unnamed instance from its slug', () => {
    const [node] = buildLayerTree(page('<div data-doop-component="grid-listagem"></div>'))
    expect(node!.label).toBe('Grid listagem')
  })

  it('shows any element by the data-name someone gave it, keeping its class beside it', () => {
    const [box, text] = buildLayerTree(
      page('<section class="filtros" data-name="Filtros"><i></i></section><p data-name="Aviso">Texto longo</p>'),
    )
    expect(box).toEqual(expect.objectContaining({ label: 'Filtros', detail: '.filtros', kind: 'box' }))
    expect(layerName(box!)).toBe('Filtros')
    expect(text).toEqual(expect.objectContaining({ label: 'Aviso', kind: 'text' }))
  })

  it('never names a layer by its bare tag: role, meaningful class and context instead', () => {
    const html = page(`
      <div class="uk-container uk-container-large">
        <div class="uk-card uk-card-default">
          <div class="uk-card-header"><h2 class="uk-card-title">Bancos</h2></div>
          <form class="uk-card-body">
            <div class="uk-width-1-3@m uk-margin-bottom"><label for="n">Número</label><input id="n" class="uk-input"></div>
            <div class="uk-width-1-1 uk-text-right"><button type="button" class="uk-button">PESQUISAR</button></div>
          </form>
        </div>
        <div style="height:16px"></div>
        <ul class="uk-list"><li><div class="uk-grid-collapse"><div class="uk-width-1-3"><p>341</p></div></div></li><li></li></ul>
        <a class="padding-nano-horizontal" aria-label="Editar"><svg viewBox="0 0 20 20"><path d="M0 0"/></svg></a>
      </div>`)
    const [container] = buildLayerTree(html)
    const [card, spacer, list, edit] = container!.children
    const [header, form] = card!.children
    const [field, actions] = form!.children
    expect(container!.label).toBe('Container · Bancos')
    expect(container!.detail).toBe('.uk-container')
    expect(card!.label).toBe('Card · Bancos')
    expect(header!.label).toBe('Card header · Bancos')
    expect(header!.children[0]!.label).toBe('Heading · Bancos')
    expect(form!.label).toBe('Form · Número')
    expect(field!.label).toBe('Field · Número')
    expect(field!.children.map((n) => n.label)).toEqual(['Label · Número', 'Text field · Número'])
    expect(actions!.label).toBe('Group · PESQUISAR')
    expect(actions!.children[0]!.label).toBe('Button · PESQUISAR')
    expect(spacer!.label).toBe('Spacer')
    expect(spacer!.detail).toBe('div')
    expect(list!.label).toBe('List · 2 items')
    expect(list!.children[0]!.label).toBe('Item · 341')
    expect(list!.children[0]!.children[0]!.label).toBe('Group · 341')
    expect(edit!.label).toBe('Link · Editar')
    expect(edit!.children.map((n) => n.label)).toEqual(['Icon'])
    const labels = JSON.stringify(container)
    expect(labels).not.toMatch(/"label":"(div|span|svg|form|ul|li|a)"/)
  })

  it('counts a collection of look-alike children instead of quoting the first', () => {
    const [steps] = buildLayerTree(
      page(
        '<div class="steps"><div class="step"><b>1</b> Hit</div><div class="step"><b>2</b> Go</div><div class="step"><b>3</b> Ask</div></div>',
      ),
    )
    expect(steps!.label).toBe('Steps · 3 items')
    expect(steps!.children[0]!.label).toBe('Step · 1')
  })

  it('names images and icons by their alt and title', () => {
    const [img, svg] = buildLayerTree(page('<img src="x.png" alt="Logo Ativus"><svg><title>Seta</title></svg>'))
    expect(img!.label).toBe('Image · Logo Ativus')
    expect(svg!.label).toBe('Vector · Seta')
  })
})

describe('ensureInstanceName', () => {
  it('names the instance root once, escaping the name', () => {
    const html = '<div class="a" data-doop-component="card"><span data-doop-component="badge"></span></div>'
    const named = ensureInstanceName(html, 'card', 'Card "A" & <B>')
    expect(named).toBe(
      '<div class="a" data-doop-component="card" data-name="Card &quot;A&quot; &amp; &lt;B>"><span data-doop-component="badge"></span></div>',
    )
    expect(ensureInstanceName(named, 'card', 'Other')).toBe(named)
    expect(ensureInstanceName('<input data-doop-component="campo" />', 'campo', 'Campo')).toBe(
      '<input data-doop-component="campo" data-name="Campo" />',
    )
  })
})
