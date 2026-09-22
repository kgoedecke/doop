import type { SessionContext } from '@cantelop/sdk/session'
import type { Command, Event, Reply } from './contracts.js'
import { terminalCrypto } from './terminal-crypto.js'
import { nativeLogin, type LoginLauncher, type LoginProcess } from './login-process.js'
type Context = SessionContext<Command, Event, Reply>
const transport = terminalCrypto()
export class Login {
  private settled?: Promise<void>
  private finished?: Extract<Event, { type: 'auth.finished' }>
  private attempt?: {
    id: string
    key: CryptoKey
    publicKey: JsonWebKey
    peer: string
    expiresAt: number
    inputSequence: number
    outputSequence: number
    controller: AbortController
    process?: LoginProcess
    outcome?: 'cancelled' | 'expired'
    inputBytes: number
  }
  constructor(
    private authenticated: () => Promise<boolean>,
    private launch: LoginLauncher = nativeLogin(),
    private timeoutMs = 10 * 60 * 1000,
    private logout: () => Promise<void> = async () => {
      throw new Error('Logout unavailable')
    },
  ) {}
  async receive(context: Context): Promise<boolean> {
    const command = context.message.payload
    if (!command.type.startsWith('auth.')) return false
    // One deterministic auth actor per user. Agent actors cannot launch a login.
    if (!context.session.id.endsWith(':auth')) {
      if (command.type === 'auth.check' || command.type === 'auth.logout') {
        context.reply({ type: 'error', code: 'auth_session_required' })
        return true
      }
      await context.output.send({ type: 'error', code: 'auth_session_required' })
      return true
    }
    if (command.type === 'auth.logout') {
      if (this.attempt) {
        this.attempt.outcome = 'cancelled'
        this.attempt.controller.abort()
      }
      await this.settled
      await this.logout()
      this.finished = undefined
      context.reply({ type: 'auth.status', authenticated: false })
      return true
    }
    if (command.type === 'auth.check') {
      context.reply({ type: 'auth.status', authenticated: await this.authenticated() })
      return true
    }
    if (command.type === 'auth.start') {
      if (this.finished?.attemptId === command.attemptId) {
        await context.output.send(this.finished)
        return true
      }
      if (this.attempt) {
        if (this.attempt.id === command.attemptId && this.attempt.peer === JSON.stringify(command.publicKey))
          await context.output.send({
            type: 'auth.started',
            attemptId: this.attempt.id,
            publicKey: this.attempt.publicKey,
            expiresAt: this.attempt.expiresAt,
          })
        else
          await context.output.send({
            type: 'auth.error',
            attemptId: command.attemptId,
            code: 'login_busy',
            activeAttemptId: this.attempt.id,
          })
        return true
      }
      if (context.activity.active) {
        await context.output.send({ type: 'auth.error', attemptId: command.attemptId, code: 'login_busy' })
        return true
      }
      if (!command.force && (await this.authenticated())) {
        await context.output.send({
          type: 'auth.finished',
          attemptId: command.attemptId,
          outcome: 'succeeded',
          authenticated: true,
        })
        return true
      }
      const pair = await transport.generate()
      let key: CryptoKey
      try {
        key = await transport.derive(pair.privateKey, command.publicKey)
      } catch {
        await context.output.send({ type: 'auth.error', attemptId: command.attemptId, code: 'invalid_public_key' })
        return true
      }
      const current = (this.attempt = {
        id: command.attemptId,
        key,
        publicKey: pair.publicKey,
        peer: JSON.stringify(command.publicKey),
        expiresAt: Date.now() + this.timeoutMs,
        inputSequence: 0,
        outputSequence: 0,
        controller: new AbortController(),
        inputBytes: 0,
      } as NonNullable<Login['attempt']>)
      let settled!: () => void
      this.settled = new Promise<void>((resolve) => {
        settled = resolve
      })
      context.activity.start(
        async (activity) => {
          try {
            const abort = () => {
              current.outcome ??= 'cancelled'
              current.controller.abort()
            }
            activity.signal.addEventListener('abort', abort, { once: true })
            if (activity.signal.aborted) abort()
            const timer = setTimeout(() => {
              current.outcome = 'expired'
              current.controller.abort()
            }, this.timeoutMs)
            let outcome: 'succeeded' | 'failed' | 'cancelled' | 'expired' = 'failed',
              authenticated = false
            try {
              await activity.output.send({
                type: 'auth.started',
                attemptId: current.id,
                publicKey: current.publicKey,
                expiresAt: current.expiresAt,
              })
              current.process = this.launch(current.controller.signal, async (text) => {
                const sequence = ++current.outputSequence
                const frame = await transport.seal(current.key, text, `${current.id}:output:${sequence}`)
                await activity.output.send({
                  type: 'auth.output',
                  attemptId: current.id,
                  terminalSequence: sequence,
                  ...frame,
                })
              })
              const code = await current.process.done
              authenticated = await this.authenticated()
              outcome = current.outcome ?? (code === 0 && authenticated ? 'succeeded' : 'failed')
            } catch {
              outcome = current.outcome ?? 'failed'
            } finally {
              clearTimeout(timer)
              current.process?.stop()
              await current.process?.done.catch(() => {})
              activity.signal.removeEventListener('abort', abort)
              this.attempt = undefined
            }
            this.finished = { type: 'auth.finished', attemptId: current.id, outcome, authenticated }
            if (!activity.signal.aborted) await activity.output.send(this.finished)
          } finally {
            settled()
          }
        },
        { timeoutMs: this.timeoutMs + 30_000 },
      )
      return true
    }
    if (command.type === 'auth.cancel' || command.type === 'auth.input') {
      const current = this.attempt
      if (!current || current.id !== command.attemptId) {
        await context.output.send({ type: 'auth.error', attemptId: command.attemptId, code: 'login_not_active' })
        return true
      }
      if (command.type === 'auth.cancel') {
        current.outcome = 'cancelled'
        current.controller.abort()
        return true
      }
      if (command.sequence <= current.inputSequence) return true // Idempotent transport retry.
      if (command.sequence !== current.inputSequence + 1 || !current.process || current.controller.signal.aborted) {
        await context.output.send({ type: 'auth.error', attemptId: current.id, code: 'input_not_ready' })
        return true
      }
      try {
        const data = await transport.open(current.key, command, `${current.id}:input:${command.sequence}`)
        if (Buffer.byteLength(data) > 4096 || current.inputBytes + Buffer.byteLength(data) > 32 * 1024)
          throw new Error('Input limit')
        await current.process.write(data)
        current.inputSequence = command.sequence
        current.inputBytes += Buffer.byteLength(data)
      } catch {
        await context.output.send({ type: 'auth.error', attemptId: current.id, code: 'input_rejected' })
      }
      return true
    }
    return true
  }
}
