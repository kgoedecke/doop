import type { ModelAccountKind, ModelAccountStatus } from './api'

export type ActiveModelTarget = 'claude-local' | ModelAccountKind | null

export function activeModelTarget(localEnabled: boolean, account: ModelAccountStatus | null): ActiveModelTarget {
  if (localEnabled) return 'claude-local'
  if (account?.connected && account.kind) return account.kind
  return null
}
