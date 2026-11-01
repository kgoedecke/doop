/** The "Agent keys" pane of /settings: minting and revoking MCP bearer keys. */
export const agentKeys = {
  loadFailed: 'Your keys could not be loaded',
  createFailed: 'That key could not be created',
  revokeFailed: 'That key could not be revoked',

  title: 'Agent keys',
  description:
    'Bearer credentials for the MCP endpoint, for agents that cannot open a browser to sign in, such as a Mastra workflow, n8n or CI. A key acts as you: everything it designs is attributed to you, and it reaches exactly the canvases you can. Revoking cuts it off immediately.',
  newKeyRow: 'New key',
  creating: 'Creating…',
  createKey: 'Create key',
  namePlaceholder: 'What will use it, e.g. mastra-prod',
  nameAria: 'Agent key name',

  yourNewKey: 'Your new key',
  copyNow: 'Copy it now: it is shown once and stored hashed.',
  headlessConfigLabel: 'MCP config for a headless client',

  revokeAria: 'Revoke {name}',
  revoke: 'Revoke',
  createdLastUsed: 'created {created} · last used {used}',
  createdNeverUsed: 'created {created} · never used',
  noKeysRow: 'No keys yet',
  noKeysNote: 'Interactive clients (Claude Code, Codex) don’t need one. They sign in with OAuth.',

  revokeConfirmTitle: 'Revoke “{name}”?',
  revokeConfirmDescription: 'Agents using it lose access immediately.',
  revokeConfirm: 'Revoke key',
} as const
