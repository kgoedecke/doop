import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import type { Message, SessionConfig } from './contracts.js'
export interface State {
  conversationId: string
  resume: boolean
  config?: SessionConfig
  messages: Message[]
  queue: string[]
}
export class StateStore {
  private writes: Promise<void> = Promise.resolve()
  private path: string
  constructor(
    private workspace: string,
    sessionId: string,
  ) {
    this.path = `${workspace}/.cantelop/${createHash('sha256').update(sessionId).digest('hex')}.json`
  }
  async load(): Promise<State> {
    await mkdir(`${this.workspace}/.cantelop`, { recursive: true, mode: 0o700 })
    await mkdir(`${this.workspace}/.claude`, { recursive: true, mode: 0o700 })
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as State
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { conversationId: randomUUID(), resume: false, messages: [], queue: [] }
    }
  }
  save(state: State): Promise<void> {
    const snapshot = JSON.stringify(state)
    const write = this.writes.then(async () => {
      const temporary = `${this.path}.${randomUUID()}.tmp`
      await writeFile(temporary, snapshot, { mode: 0o600 })
      await rename(temporary, this.path)
    })
    // A failed durable write poisons subsequent writes; don't silently drop state.
    this.writes = write
    return write
  }
}
