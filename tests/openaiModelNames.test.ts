import { describe, expect, it } from 'vitest'
import { mergeCatalog } from '../server/modelCatalog.ts'
import { AGENT_MODELS, modelFor } from '../server/openaiAgent.ts'
import { openaiDisplayName, openaiGeneration, openaiModelName, type ModelOption } from '../shared/modelMenu.ts'

/**
 * The OpenAI menu is the curated tiers plus whatever the provider's catalog
 * lists. Both halves have to read as one list: the same spelling for every
 * id, and the newest generation on top, whether or not the curated tiers
 * have caught up with it.
 */

const option = (id: string, name = id): ModelOption => ({ id, name, blurb: '', vision: true })

describe('the OpenAI default', () => {
  it('moves an account with no pick of its own to the everyday tier', () => {
    expect(modelFor({ model: undefined })).toBe('gpt-6.2-sol')
  })

  it('keeps an explicit pick, an older tier included', () => {
    expect(modelFor({ model: 'gpt-5.6-terra' })).toBe('gpt-5.6-terra')
  })
})

describe('openaiModelName', () => {
  it('spells an id the way the curated menu does', () => {
    expect(openaiModelName('gpt-6.1-sol')).toBe('GPT-6.1 Sol')
    expect(openaiModelName('gpt-6-luna')).toBe('GPT-6 Luna')
    expect(openaiModelName('gpt-5.3-codex')).toBe('GPT-5.3 Codex')
    expect(openaiModelName('gpt-5.4-mini')).toBe('GPT-5.4 Mini')
    expect(openaiModelName('gpt-5')).toBe('GPT-5')
    expect(openaiModelName('o4-mini')).toBe('o4 Mini')
    expect(openaiModelName('o3')).toBe('o3')
  })

  it('keeps a snapshot date whole', () => {
    expect(openaiModelName('gpt-6.2-sol-2026-11-01')).toBe('GPT-6.2 Sol 2026-11-01')
  })

  it('leaves an id of another shape as it is', () => {
    expect(openaiModelName('chatgpt-image-latest')).toBe('chatgpt-image-latest')
    expect(openaiModelName('gpt-5o')).toBe('gpt-5o')
  })

  it('names every curated tier exactly as the curated menu does', () => {
    for (const model of AGENT_MODELS) expect(openaiModelName(model.id)).toBe(model.name)
  })
})

describe('openaiDisplayName', () => {
  it('formats a catalog name that only re-spells the id', () => {
    expect(openaiDisplayName('gpt-6.1-sol', 'GPT-6.1-Sol')).toBe('GPT-6.1 Sol')
    expect(openaiDisplayName('gpt-6-sol', 'gpt-6-sol')).toBe('GPT-6 Sol')
    expect(openaiDisplayName('gpt-6.1-terra', 'GPT-6.1 Terra')).toBe('GPT-6.1 Terra')
  })

  it('formats the id when the catalog gives no name', () => {
    expect(openaiDisplayName('gpt-6-luna', undefined)).toBe('GPT-6 Luna')
    expect(openaiDisplayName('gpt-6-luna', '  ')).toBe('GPT-6 Luna')
  })

  it('keeps a name that says more than the id', () => {
    expect(openaiDisplayName('gpt-6.2-sol', 'GPT-6.2 Sol (Codex)')).toBe('GPT-6.2 Sol (Codex)')
  })
})

describe('openaiGeneration', () => {
  it('reads the version out of the id', () => {
    expect(openaiGeneration('gpt-6.2-astra')).toEqual([6, 2])
    expect(openaiGeneration('gpt-6-luna')).toEqual([6, 0])
    expect(openaiGeneration('gpt-6.10-sol')).toEqual([6, 10])
    expect(openaiGeneration('o4-mini')).toEqual([0, 0])
  })
})

describe('mergeCatalog', () => {
  const curated = [option('gpt-6.2-astra'), option('gpt-6.2-sol'), option('gpt-6.1-terra'), option('gpt-6-luna')]

  it('puts the newest generation first, curated first within one', () => {
    const live = [
      option('gpt-5.6-terra'),
      option('gpt-6-luna'),
      option('gpt-6.1-sol'),
      option('gpt-6.2-sol'),
      option('o4-mini'),
      option('gpt-6-sol'),
      option('gpt-6.1-terra'),
      option('gpt-6.2-astra'),
    ]
    const merged = mergeCatalog(curated, live, openaiGeneration)
    expect(merged.map((m) => [m.id, m.recommended ?? false])).toEqual([
      ['gpt-6.2-astra', true],
      ['gpt-6.2-sol', true],
      ['gpt-6.1-terra', true],
      ['gpt-6.1-sol', false],
      ['gpt-6-luna', true],
      ['gpt-6-sol', false],
      ['gpt-5.6-terra', false],
      ['o4-mini', false],
    ])
  })

  it('puts a release the curated tiers have not caught up with on top', () => {
    const live = [option('gpt-6.2-sol'), option('gpt-6.3-sol'), option('gpt-6.1-terra')]
    expect(mergeCatalog(curated, live, openaiGeneration).map((m) => m.id)).toEqual([
      'gpt-6.3-sol',
      'gpt-6.2-sol',
      'gpt-6.1-terra',
    ])
  })

  it('keeps curated-then-catalog order where ids name no generation', () => {
    const merged = mergeCatalog([option('b'), option('a')], [option('c'), option('a'), option('b')])
    expect(merged.map((m) => m.id)).toEqual(['b', 'a', 'c'])
  })
})
