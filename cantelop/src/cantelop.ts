import { CantelopClient } from '@cantelop/sdk'
import { claudeAuth, claudeDockerfile, createClaudeRuntime } from '@cantelop/sdk/harnesses/claude'
import type {
  ClaudeSessionCommand as Command,
  ClaudeSessionEvent as Event,
  ClaudeSessionReply as Reply,
} from '@cantelop/sdk/harnesses/claude/protocol'

export const doopClaude = new CantelopClient().app<Command, Event, Reply>({
  name: 'doop-claude',
  runtime: createClaudeRuntime({ workspace: '/workspace', permissionMode: 'dontAsk', settingSources: [], tools: [] }),
  auth: claudeAuth,
  dockerfile: claudeDockerfile,
})
