import { afterEach, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import api from '../cantelop/src/api.ts'
import type { Command, Event, Reply } from '../cantelop/src/contracts.ts'
import { checkRemoteAuth, remoteIdentity, remotePost } from '../server/remoteClaudeClient.ts'
import { consumeClaudeEvents } from '../shared/remoteClaude.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function connect() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  vi.stubEnv('CLAUDE_REMOTE_URL', 'https://claude.example')
  vi.stubEnv('CLAUDE_REMOTE_ISSUER', 'doop')
  vi.stubEnv('CLAUDE_REMOTE_AUDIENCE', 'cantelop-claude-api')
  vi.stubEnv('CLAUDE_REMOTE_SIGNING_KEY', pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString())
  const opened: { id: string; workspaceSlug: string }[] = []
  const commands: Command[] = []
  const app = {
    workspaces: { open: async ({ slug }: { slug: string }) => ({ id: 'workspace', slug }) },
    sessions: {
      open: (options: { id: string; workspaceSlug: string }) => {
        opened.push(options)
        return {
          ...options,
          request: async (command: Command): Promise<Reply> => {
            commands.push(command)
            return command.type === 'snapshot'
              ? { type: 'session.state', messages: [], configured: true, truncated: false }
              : { type: 'auth.status', authenticated: command.type !== 'auth.logout' }
          },
          dispatch: async (command: Command) => {
            commands.push(command)
            return { id: 'receipt' }
          },
        }
      },
    },
  } as unknown as Parameters<typeof api.create>[0]['app']
  const router = api.create({
    app,
    env: {
      AUTH_PUBLIC_JWK: JSON.stringify(pair.publicKey.export({ format: 'jwk' })),
      AUTH_ISSUER: 'doop',
      AUTH_AUDIENCE: 'cantelop-claude-api',
    },
  })
  vi.stubGlobal('fetch', (url: string, options: RequestInit) => router.handle(new Request(url, options)))
  return { opened, commands }
}

it('accepts Doop JWTs and retains the same workspace across auth, tasks, snapshots, and logout', async () => {
  const { opened, commands } = connect()
  expect(await checkRemoteAuth('alice')).toBe(true)
  const created = await remotePost('alice', '/v1/sessions', { tools: [], allowedTools: [], mcps: {} })
  const message = await remotePost('alice', '/v1/messages', { sessionId: created.sessionId, text: 'Design a card' })
  expect(message).toMatchObject({ receiptId: 'receipt', sessionId: created.sessionId })
  expect(await remotePost('alice', '/v1/snapshot', { sessionId: created.sessionId })).toMatchObject({
    type: 'session.state',
    configured: true,
  })
  await expect(
    remotePost('bob', '/v1/cancel', { sessionId: created.sessionId, messageId: message.messageId }),
  ).rejects.toThrow('(404)')
  expect(await remotePost('alice', '/v1/auth/logout', {})).toMatchObject({ authenticated: false })
  expect(opened.every((session) => session.workspaceSlug === `u-${remoteIdentity('alice')}`)).toBe(true)
  expect(opened[0]?.id).toBe(`${remoteIdentity('alice')}:auth`)
  expect(commands.map((command) => command.type)).toEqual([
    'auth.check',
    'configure',
    'queue',
    'snapshot',
    'auth.logout',
  ])
})

it('consumes runtime output inside Cantelop transport envelopes and advances the replay cursor', async () => {
  const events: Event[] = [
    { type: 'message.status', id: 'message', status: 'running' },
    { type: 'claude', id: 'message', event: { type: 'result', is_error: false, subtype: 'success', result: 'Done' } },
    { type: 'message.status', id: 'message', status: 'completed' },
  ]
  const received: unknown[] = []
  const cursors: string[] = []
  await consumeClaudeEvents(
    new Response(
      events
        .map((data, index) => `id: stream:${index}\ndata: ${JSON.stringify({ data, message_id: 'receipt' })}\n\n`)
        .join(''),
    ),
    (event) => {
      received.push(event)
    },
    (cursor) => {
      cursors.push(cursor)
    },
  )
  expect(received).toEqual(events.map((event) => ({ ...event, message_id: 'receipt' })))
  expect(cursors).toEqual(['stream:0', 'stream:1', 'stream:2'])
})
