import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeClaude, NativeAuthRequired, isNativeAuthFailure, cliArgs, claudeEnv } from '../src/claude.js'
const config = { tools: ['Read'], allowedTools: ['Read'], mcps: {} }
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Partial SDK/DOM fixtures exercise runtime boundaries without implementing the platform.
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'cantelop-native-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const binary = join(root, 'fake-claude')
  await writeFile(
    binary,
    `#!/usr/bin/env node
const {spawn} = require('node:child_process');
if(process.argv[2]==='auth') {console.log(JSON.stringify({loggedIn:true}));process.exit(0);}
let text='';process.stdin.on('data',chunk=>text+=chunk);
process.stdin.on('end',()=>{
 const args=process.argv.slice(2), index=args.indexOf('--system-prompt-file');
 const promptPath=index<0?undefined:args[index+1];
 console.log(JSON.stringify({type:'system',subtype:'init',args,promptPath,
   systemPrompt:promptPath?require('node:fs').readFileSync(promptPath,'utf8'):undefined,
   promptMode:promptPath?require('node:fs').statSync(promptPath).mode & 0o777:undefined}));
 if(text==='wait') {
   const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log(JSON.stringify({type:'tool.ready'}));setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit']});
   setInterval(()=>{},1000);
 } else {
   console.log(JSON.stringify({type:'assistant',text:'Hello 😀'}));
   process.stdout.write(JSON.stringify({type:'result',is_error:text==='fail'}));
 }
});
`,
    { mode: 0o755 },
  )
  return new NativeClaude(root, binary)
}
test('native runner verifies auth, parses Unicode and final non-newline frame', async (t) => {
  const runtime = await fixture(t),
    events: unknown[] = []
  let initialized = false
  assert.equal(await runtime.authenticated(), true)
  await runtime.run({
    config,
    conversationId: crypto.randomUUID(),
    resume: false,
    text: 'hello',
    signal: new AbortController().signal,
    emit: async (e) => {
      events.push(e)
    },
    initialized: async () => {
      initialized = true
    },
  })
  assert.equal(initialized, true)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Partial SDK/DOM fixtures exercise runtime boundaries without implementing the platform.
  assert.ok(events.some((e: any) => e.text === 'Hello 😀'))
  assert.equal((events.at(-1) as Record<string, unknown>).type, 'result')
})
test('native process-group cancellation escalates and waits for stubborn tool descendants', async (t) => {
  const runtime = await fixture(t),
    controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), 4000)
  t.after(() => clearTimeout(deadline))
  let ready = false,
    abortedAt = 0
  const run = runtime.run({
    config,
    conversationId: crypto.randomUUID(),
    resume: false,
    text: 'wait',
    signal: controller.signal,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Partial SDK/DOM fixtures exercise runtime boundaries without implementing the platform.
    emit: async (e: any) => {
      if (e.type === 'tool.ready') {
        ready = true
        abortedAt = Date.now()
        controller.abort()
      }
    },
    initialized: async () => {},
  })
  await assert.rejects(run)
  assert.equal(ready, true)
  assert.ok(Date.now() - abortedAt >= 900, 'waited for SIGKILL escalation')
})
test('CLI flags retain explicit tools and MCPs, no shared credentials inherited', () => {
  const args = cliArgs(config, 'id', true)
  assert.ok(args.includes('--strict-mcp-config'))
  assert.ok(args.includes('--resume'))
  assert.ok(!args.includes('--dangerously-skip-permissions'))
  process.env.ANTHROPIC_API_KEY = 'must-not-be-inherited'
  try {
    assert.equal(claudeEnv('/workspace').ANTHROPIC_API_KEY, undefined)
  } finally {
    delete process.env.ANTHROPIC_API_KEY
  }
})

test('execution settings reach the subprocess; private prompt files are removed on success and failure', async (t) => {
  const runtime = await fixture(t)
  for (const text of ['hello', 'fail']) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Partial SDK/DOM fixtures exercise runtime boundaries without implementing the platform.
    const events: any[] = []
    const run = runtime.run({
      config: { ...config, model: 'sonnet', maxTurns: 24, systemPrompt: 'Rules 😀\nSecond line' },
      conversationId: crypto.randomUUID(),
      resume: text === 'fail',
      text,
      signal: new AbortController().signal,
      emit: async (e) => {
        events.push(e)
      },
      initialized: async () => {},
    })
    if (text === 'fail') await assert.rejects(run)
    else await run
    const init = events[0]
    assert.equal(init.args[init.args.indexOf('--model') + 1], 'sonnet')
    assert.equal(init.args[init.args.indexOf('--max-turns') + 1], '24')
    assert.equal(init.systemPrompt, 'Rules 😀\nSecond line')
    assert.equal(init.promptMode, 0o600)
    assert.ok(!init.args.includes(init.systemPrompt))
    assert.ok(init.args.includes(text === 'fail' ? '--resume' : '--session-id'))
    await assert.rejects(access(init.promptPath))
  }
})
test('omitted execution settings and default model preserve native defaults', () => {
  for (const settings of [config, { ...config, model: 'default' }]) {
    const args = cliArgs(settings, 'id', false)
    for (const flag of ['--model', '--max-turns', '--system-prompt-file']) assert.ok(!args.includes(flag))
  }
})

test('only structured native authentication errors request re-login', () => {
  assert.equal(isNativeAuthFailure({ type: 'assistant', error: 'authentication_failed' }), true)
  for (const error of ['rate_limit', 'billing_error', 'server_error', 'unknown', 'overloaded'])
    assert.equal(isNativeAuthFailure({ type: 'assistant', error }), false)
  assert.equal(isNativeAuthFailure({ type: 'result', result: 'authentication_failed' }), false)
  assert.equal(isNativeAuthFailure({ type: 'user', error: 'authentication_failed' }), false)
})
test('native runner reports terminal auth failure but allows successful recovery', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cantelop-auth-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const binary = join(root, 'fake-claude')
  await writeFile(
    binary,
    `#!/usr/bin/env node
process.stdin.resume(); process.stdin.on('end',()=>{
console.log(JSON.stringify({type:'assistant',error:'authentication_failed'}));
console.log(JSON.stringify({type:'result',is_error:process.argv.includes('--resume')===false}));
});`,
    { mode: 0o755 },
  )
  const runtime = new NativeClaude(root, binary)
  const turn = {
    config,
    conversationId: crypto.randomUUID(),
    resume: false,
    text: 'test',
    signal: new AbortController().signal,
    emit: async () => {},
    initialized: async () => {},
  }
  await assert.rejects(runtime.run(turn), NativeAuthRequired)
  await runtime.run({ ...turn, resume: true })
})
test('status command failures are unavailable, not signed-out', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cantelop-status-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await assert.rejects(new NativeClaude(root, join(root, 'missing')).authenticated(), /unavailable/)
  const binary = join(root, 'fake-claude')
  await writeFile(binary, '#!/usr/bin/env node\nconsole.log(JSON.stringify({loggedIn:false}));process.exit(1);', {
    mode: 0o755,
  })
  assert.equal(await new NativeClaude(root, binary).authenticated(), false)
})

test('native logout uses the workspace credentials and verifies signed-out status', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cantelop-logout-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const binary = join(root, 'claude')
  await writeFile(
    binary,
    `#!/usr/bin/env node
const fs=require('node:fs');
if(require('node:path').join(fs.realpathSync(require('node:path').dirname(process.env.CLAUDE_CONFIG_DIR)),'.claude')!==process.cwd()+'/.claude') process.exit(2);
if(process.argv.slice(2).join(' ')==='auth logout') {fs.writeFileSync('signed-out','');process.exit(0);}
console.log(JSON.stringify({loggedIn:!fs.existsSync('signed-out')}));
`,
    { mode: 0o755 },
  )
  const runtime = new NativeClaude(root, binary)
  assert.equal(await runtime.authenticated(), true)
  await runtime.logout()
  assert.equal(await runtime.authenticated(), false)
  await runtime.logout()
})
test('logout refuses to report success if credentials remain active', async (t) => {
  const runtime = await fixture(t)
  await assert.rejects(runtime.logout(), /sign-out could not be confirmed/)
})
