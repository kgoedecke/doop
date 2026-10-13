import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createClaudeHarness, createClaudeRuntime } from '@cantelop/sdk/harnesses/claude'
import type { SessionActivityFunction, SessionActivationContext, SessionContext } from '@cantelop/sdk/session'
import type { Command, Event, Reply } from '../src/contracts.js'

test('Doop uses the real SDK factory for restrictions, fragments and native resume across turns', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'doop-factory-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const binary = join(workspace, 'claude')
  await writeFile(
    binary,
    `#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2);
let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>{
const id=args.at(-1),index=args.indexOf('--system-prompt-file'),promptPath=index<0?undefined:args[index+1];
console.log(JSON.stringify({type:'system',subtype:'init',session_id:id,args,promptPath,
  systemPrompt:promptPath?fs.readFileSync(promptPath,'utf8'):undefined,
  promptMode:promptPath?fs.statSync(promptPath).mode&0o777:undefined}));
console.log(JSON.stringify({type:'result',is_error:false,subtype:'success',result:text==='large'?'😀'.repeat(40000):'Done'}));
});`,
    { mode: 0o755 },
  )
  let factories = 0
  const behaviour = createClaudeRuntime(
    { workspace, permissionMode: 'dontAsk', settingSources: [] },
    (context, options) => {
      factories++
      return createClaudeHarness(context, options)
    },
  )
  const events: Event[] = []
  const lifetime = new AbortController()
  let active = false,
    task = Promise.resolve()
  const output = {
    send: async (event: Event) => {
      events.push(event)
    },
  }
  const view = { commit: async () => {} }
  const activity = {
    get active() {
      return active
    },
    start(work: SessionActivityFunction<Command, Event>) {
      active = true
      const followups: Command[] = []
      task = Promise.resolve()
        .then(() =>
          work({
            signal: lifetime.signal,
            output,
            view,
            send: (message) => {
              followups.push(message)
            },
          }),
        )
        .then(async () => {
          active = false
          for (const message of followups) await receive(message)
        })
    },
    queue() {
      throw new Error('Not used')
    },
    steer: async () => {},
    cancel: () => false,
    extend() {},
  }
  const resources: SessionActivationContext<Command, Event> = {
    signal: lifetime.signal,
    session: { id: 'real-sdk-factory', workspaceSlug: 'user', keepAliveSeconds: 300 },
    env: { CLAUDE_PATH: binary, CLAUDE_MODEL: 'must-not-override-native-default' },
    database: async () => {
      throw new Error('Not used')
    },
    output,
    view,
    activity,
    send: async (message) => {
      await receive(message)
    },
  }
  async function receive(command: Command) {
    await behaviour.receive({
      ...resources,
      command: { type: 'dispatch' },
      message: { id: `msg_${randomUUID().replaceAll('-', '')}`, sequence: 1, payload: command },
      reply: (_reply: Reply) => {},
    } as SessionContext<Command, Event, Reply>)
  }
  await behaviour.onActivate(resources)
  await receive({
    type: 'configure',
    config: {
      model: 'default',
      tools: [],
      allowedTools: ['mcp__doop__edit'],
      mcps: { doop: { type: 'http', url: 'https://tools.example/mcp', headers: { Authorization: 'run-token' } } },
      systemPrompt: 'Canvas rules 😀',
      maxTurns: 24,
    },
  })
  await receive({ type: 'queue', id: 'first', text: 'large' })
  await task
  const init = events.find(
    (event) => event.type === 'claude' && (event.event as Record<string, unknown>).type === 'system',
  )!
  assert.equal(init.type, 'claude')
  const native = init.event as { args: string[]; promptPath: string; systemPrompt: string; promptMode: number }
  const flag = (name: string) => native.args[native.args.indexOf(name) + 1]
  assert.equal(flag('--tools'), '')
  assert.equal(flag('--allowedTools'), 'mcp__doop__edit')
  assert.equal(flag('--permission-mode'), 'dontAsk')
  assert.equal(flag('--setting-sources'), '')
  assert.equal(flag('--max-turns'), '24')
  assert.ok(!native.args.includes('--model'))
  assert.deepEqual(JSON.parse(flag('--mcp-config')!), {
    mcpServers: { doop: { type: 'http', url: 'https://tools.example/mcp', headers: { Authorization: 'run-token' } } },
  })
  assert.equal(native.systemPrompt, 'Canvas rules 😀')
  assert.equal(native.promptMode, 0o600)
  await assert.rejects(access(native.promptPath))
  const fragments = events.filter((event) => event.type === 'claude.fragment' && event.id === 'first')
  assert.ok(fragments.length > 1)
  assert.equal(JSON.parse(fragments.map((fragment) => fragment.json).join('')).result, '😀'.repeat(40000))
  await receive({ type: 'queue', id: 'second', text: 'again' })
  await task
  assert.equal(factories, 1)
  const second = events.find(
    (event) =>
      event.type === 'claude' && event.id === 'second' && (event.event as Record<string, unknown>).type === 'system',
  )!
  assert.equal(second.type, 'claude')
  assert.ok((second.event as { args: string[] }).args.includes('--resume'))
  assert.ok(
    events.some((event) => event.type === 'message.status' && event.id === 'second' && event.status === 'completed'),
  )
})
