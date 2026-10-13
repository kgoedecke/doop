import { CantelopClient } from '@cantelop/sdk'
import { claudeAuth, claudeDockerfile, createClaudeRuntime } from '@cantelop/sdk/harnesses/claude'
import type { Command, Event, Reply } from './contracts.js'

export const doopClaude = new CantelopClient().app<Command, Event, Reply>({
  name: 'doop-claude-runtime',
  runtime: createClaudeRuntime({ workspace: '/workspace', permissionMode: 'dontAsk', settingSources: [] }),
  auth: claudeAuth,
  dockerfile: claudeDockerfile,
})
