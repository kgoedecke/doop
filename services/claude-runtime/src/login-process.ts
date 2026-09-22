import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { claudeEnv } from './claude.js'
export interface LoginProcess {
  done: Promise<number | null>
  write(data: string): Promise<void>
  stop(): void
}
export type LoginLauncher = (signal: AbortSignal, output: (text: string) => Promise<void>) => LoginProcess
export function nativeLogin(
  workspace = '/workspace',
  helper = '/opt/app/login-pty.py',
  binary = 'claude',
): LoginLauncher {
  return (signal, output) => {
    signal.throwIfAborted()
    const child = spawn('python3', ['-u', helper, binary, 'auth', 'login'], {
      cwd: workspace,
      env: { ...claudeEnv(workspace), TERM: 'dumb', BROWSER: '/bin/true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let closed = false
    const stop = () => {
      if (!closed) child.kill('SIGTERM')
    }
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    child.stdin.on('error', () => {})
    child.stderr.resume()
    child.stdout.setEncoding('utf8')
    const exit = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => {
        closed = true
        resolve(code)
      })
    })
    void exit.catch(() => {})
    const done = (async () => {
      let bytes = 0
      try {
        for await (const chunk of child.stdout) {
          const text = String(chunk)
          bytes += Buffer.byteLength(text)
          if (bytes > 512 * 1024) throw new Error('Login output limit')
          for (let i = 0; i < text.length; i += 4000) await output(text.slice(i, i + 4000))
        }
        return await exit
      } finally {
        stop()
        await exit.catch(() => {})
        signal.removeEventListener('abort', stop)
      }
    })()
    // A process can fail before the activity begins awaiting its result.
    void done.catch(() => {})
    return {
      done,
      stop,
      write: async (data) => {
        if (closed || !child.stdin.writable) throw new Error('Login ended')
        if (!child.stdin.write(data)) await once(child.stdin, 'drain')
      },
    }
  }
}
