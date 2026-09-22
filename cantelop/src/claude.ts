import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionConfig } from './contracts.js'
const exec = promisify(execFile)
export function claudeEnv(workspace: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  env.CLAUDE_CONFIG_DIR = `${workspace}/.claude`
  return env
}
export function cliArgs(
  config: SessionConfig,
  conversationId: string,
  resume: boolean,
  systemPromptPath?: string,
): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'dontAsk',
    '--setting-sources',
    '',
    '--tools',
    config.tools.join(','),
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify({ mcpServers: config.mcps }),
    ...(config.allowedTools.length ? ['--allowedTools', config.allowedTools.join(',')] : []),
    ...(config.model && config.model !== 'default' ? ['--model', config.model] : []),
    ...(config.maxTurns !== undefined ? ['--max-turns', String(config.maxTurns)] : []),
    ...(systemPromptPath ? ['--system-prompt-file', systemPromptPath] : []),
    resume ? '--resume' : '--session-id',
    conversationId,
  ]
}
export interface Turn {
  config: SessionConfig
  conversationId: string
  resume: boolean
  text: string
  signal: AbortSignal
  emit(event: unknown): Promise<void>
  initialized(): Promise<void>
}
export interface ClaudeRuntime {
  authenticated(): Promise<boolean>
  logout(): Promise<void>
  run(turn: Turn): Promise<void>
}
export class NativeAuthRequired extends Error {
  constructor() {
    super('Claude sign-in required')
  }
}
export function isNativeAuthFailure(event: Record<string, unknown>): boolean {
  return event.type === 'assistant' && event.error === 'authentication_failed'
}
function authStatus(stdout: string): boolean {
  const value = JSON.parse(stdout)
  if (typeof value.loggedIn !== 'boolean') throw new Error('Claude authentication status unavailable')
  return value.loggedIn
}
export class NativeClaude implements ClaudeRuntime {
  constructor(
    private workspace = '/workspace',
    private binary = 'claude',
  ) {}
  async authenticated(): Promise<boolean> {
    try {
      const { stdout } = await exec(this.binary, ['auth', 'status'], {
        cwd: this.workspace,
        env: claudeEnv(this.workspace),
        timeout: 15000,
        maxBuffer: 65536,
      })
      return authStatus(stdout)
    } catch (error) {
      // A signed-out CLI exits nonzero but still reports structured status.
      const failure = error as { stdout?: string; killed?: boolean; signal?: string }
      if (!failure.killed && !failure.signal && failure.stdout) return authStatus(failure.stdout)
      // eslint-disable-next-line preserve-caught-error -- Do not retain native process output in surfaced auth errors.
      throw new Error('Claude authentication status unavailable')
    }
  }
  async logout(): Promise<void> {
    try {
      await exec(this.binary, ['auth', 'logout'], {
        cwd: this.workspace,
        env: claudeEnv(this.workspace),
        timeout: 15000,
        maxBuffer: 65536,
      })
      if (await this.authenticated()) throw new Error('Still authenticated')
    } catch {
      throw new Error('Claude sign-out could not be confirmed')
    }
  }
  async run(turn: Turn): Promise<void> {
    turn.signal.throwIfAborted()
    // Keep prompt text out of process arguments; unique private files also
    // isolate simultaneous sessions sharing the user's Workspace.
    let directory: string | undefined
    try {
      let promptPath: string | undefined
      if (turn.config.systemPrompt !== undefined) {
        directory = await mkdtemp(join(tmpdir(), 'cantelop-prompt-'))
        promptPath = join(directory, 'system.txt')
        await writeFile(promptPath, turn.config.systemPrompt, { mode: 0o600 })
      }
      await this.runNative(turn, promptPath)
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true })
    }
  }
  private async runNative(turn: Turn, systemPromptPath?: string): Promise<void> {
    turn.signal.throwIfAborted()
    const child = spawn(this.binary, cliArgs(turn.config, turn.conversationId, turn.resume, systemPromptPath), {
      cwd: this.workspace,
      env: claudeEnv(this.workspace),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let exited = false,
      escalation: ReturnType<typeof setTimeout> | undefined
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
    }
    const stop = () => {
      if (exited || escalation) return
      signalGroup('SIGTERM')
      escalation = setTimeout(() => signalGroup('SIGKILL'), 1000)
    }
    const done = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => {
        exited = true
        resolve(code)
      })
    })
    // Attach immediately: spawn failures can precede reading stdout.
    void done.catch(() => {})
    turn.signal.addEventListener('abort', stop, { once: true })
    if (turn.signal.aborted) stop()
    child.stdin.on('error', () => {})
    child.stdin.end(turn.text)
    child.stderr.resume()
    child.stdout.setEncoding('utf8')
    let pending = '',
      result = false,
      failed = false,
      authFailed = false
    const line = async (text: string) => {
      if (!text.trim()) return
      let event: Record<string, unknown>
      try {
        event = JSON.parse(text)
      } catch {
        return
      }
      if (!event || typeof event !== 'object') return
      authFailed ||= isNativeAuthFailure(event)
      if (event.type === 'system' && event.subtype === 'init') await turn.initialized()
      if (event.type === 'result') {
        result = true
        failed ||= event.is_error === true
      }
      await turn.emit(event)
    }
    try {
      for await (const chunk of child.stdout) {
        pending += chunk
        if (pending.length > 4 * 1024 * 1024) throw new Error('Claude output frame exceeds limit')
        let index: number
        while ((index = pending.indexOf('\n')) >= 0) {
          const text = pending.slice(0, index)
          pending = pending.slice(index + 1)
          await line(text)
        }
      }
      await line(pending)
      const code = await done
      turn.signal.throwIfAborted()
      if (code !== 0 || !result || failed) {
        if (authFailed) throw new NativeAuthRequired()
        throw new Error('Claude turn failed')
      }
    } finally {
      stop()
      // Always await the real native process, even when output transport fails.
      await done.catch(() => {})
      if (escalation) clearTimeout(escalation)
      // Remove leftover tools in this turn's process group before the next turn.
      signalGroup('SIGKILL')
      turn.signal.removeEventListener('abort', stop)
    }
  }
}
