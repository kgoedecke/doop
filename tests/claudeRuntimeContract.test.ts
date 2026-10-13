import { afterEach, expect, it, vi } from 'vitest'
import { CantelopClient } from '@cantelop/sdk'
import type {
  ClaudeSessionCommand as Command,
  ClaudeSessionEvent as Event,
  ClaudeSessionReply as Reply,
} from '@cantelop/sdk/harnesses/claude/protocol'
import { checkRemoteAuth, remoteIdentity, remoteSession, remoteWorkspace } from '../server/remoteClaudeClient.ts'

const mocks = vi.hoisted(() => ({ app: undefined as unknown }))
vi.mock('../server/remoteClaudeApp.ts', () => ({ loadClaudeApp: async () => mocks.app }))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

it('uses real SDK protocol 2 with backend credentials and preserves user Workspaces across auth/tasks/logout', async () => {
  vi.stubEnv('CLAUDE_REMOTE_URL', 'https://claude.example')
  vi.stubEnv('CLAUDE_REMOTE_ISSUER', 'doop')
  vi.stubEnv('CANTELOP_INTEGRATION_TOKEN', 'app-scoped-token')
  const commands: {
    workspace: { slug: string }
    session: { id: string }
    command: { type: string; message?: Command; auth?: { type: string } }
    id: string
  }[] = []
  mocks.app = new CantelopClient().app<Command, Event, Reply>({
    name: 'doop-claude-runtime',
    runtime: { receive() {} },
    auth: {
      status: () => true,
      logout() {},
      terminal() {
        throw new Error('native-only')
      },
    },
    edgeUrl: 'https://claude.example',
    accessToken: 'app-scoped-token',
  })
  vi.stubGlobal('fetch', async (request: Request) => {
    expect(request.url).toBe('https://claude.example/commands')
    expect(request.headers.get('Authorization')).toBe('Bearer app-scoped-token')
    const envelope = await request.json()
    expect(envelope.protocolVersion).toBe(2)
    expect(envelope.id).toMatch(/^msg_[0-9a-f]{32}$/)
    commands.push(envelope)
    if (envelope.command.type === 'auth')
      return Response.json({
        protocolVersion: 2,
        id: envelope.id,
        reply: { type: 'status', authenticated: envelope.command.auth.type !== 'logout' },
      })
    if (envelope.command.type === 'request')
      return Response.json({
        protocolVersion: 2,
        id: envelope.id,
        reply: { type: 'session.state', configured: true, messages: [], truncated: false },
      })
    return Response.json({
      protocolVersion: 2,
      id: envelope.id,
      status: 'accepted',
      accepted_at: new Date().toISOString(),
    })
  })
  expect(await checkRemoteAuth('alice')).toBe(true)
  const session = await remoteSession('alice')
  await session.request({ type: 'configure', config: { tools: [], allowedTools: [], mcps: {} } })
  const id = crypto.randomUUID()
  const message = await session.dispatch(
    { type: 'queue', id, text: 'Design a card' },
    { id: `msg_${id.replaceAll('-', '')}` },
  )
  expect(message.id).toBe(`msg_${id.replaceAll('-', '')}`)
  expect(await session.request({ type: 'snapshot' })).toMatchObject({ type: 'session.state', configured: true })
  await expect(remoteSession('bob', session.id)).rejects.toThrow()
  expect(await (await remoteWorkspace('alice')).auth().logout()).toBe(false)
  expect(commands.every((command) => command.workspace.slug === `u-${remoteIdentity('alice')}`)).toBe(true)
  expect(commands[0]?.session.id).toBe('cantelop-native-auth')
  expect(commands.map((command) => command.command.type)).toEqual(['auth', 'request', 'dispatch', 'request', 'auth'])
  expect(commands[1]?.command.message).toMatchObject({ type: 'configure' })
  expect(commands[2]?.command.message).toMatchObject({ type: 'queue', id })
})
