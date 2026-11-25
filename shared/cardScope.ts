import type { CardScope, CardTarget } from './types.ts'

export const MAX_CARD_TARGETS = 128

export function exceedsCardTargetLimit(scope: unknown): boolean {
  return (
    !!scope &&
    typeof scope === 'object' &&
    'additionalTargets' in scope &&
    Array.isArray(scope.additionalTargets) &&
    scope.additionalTargets.length >= MAX_CARD_TARGETS
  )
}

export function scopeFromTargets(targets: CardTarget[]): CardScope | undefined {
  const primary = targets.at(-1)
  if (!primary) return undefined
  return targets.length === 1 ? primary : { ...primary, additionalTargets: targets.slice(0, -1) }
}

export function scopeTargets(scope: CardScope): CardTarget[] {
  return [...(scope.additionalTargets ?? []), scope]
}

export function parseCardScope(value: unknown, hasFrame?: (id: string) => boolean): CardScope | undefined {
  if (!value || typeof value !== 'object' || exceedsCardTargetLimit(value)) return undefined
  const additional: unknown[] =
    'additionalTargets' in value && Array.isArray(value.additionalTargets) ? value.additionalTargets : []
  const targets = new Map<string, CardTarget>()
  for (const item of [...additional, value]) {
    if (!item || typeof item !== 'object') continue
    const { frameId, selector } = item as Record<string, unknown>
    if (typeof frameId !== 'string' || (hasFrame && !hasFrame(frameId))) continue
    const trimmed = typeof selector === 'string' ? selector.trim().slice(0, 1_000) : ''
    const target = trimmed ? { frameId, selector: trimmed } : { frameId }
    const key = JSON.stringify(target)
    targets.delete(key)
    targets.set(key, target)
  }
  return scopeFromTargets([...targets.values()])
}
