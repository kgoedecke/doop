export type McpServer =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }
export interface SessionConfig {
  model?: string
  systemPrompt?: string
  maxTurns?: number
  tools: string[]
  allowedTools: string[]
  mcps: Record<string, McpServer>
}
export type Command =
  | { type: 'auth.check' | 'auth.logout' | 'snapshot' | 'drain' }
  | { type: 'auth.start'; attemptId: string; publicKey: JsonWebKey; force?: boolean }
  | { type: 'auth.input'; attemptId: string; sequence: number; iv: string; data: string }
  | { type: 'auth.cancel'; attemptId: string }
  | { type: 'configure'; config: SessionConfig }
  | { type: 'queue' | 'steer'; id: string; text: string }
  | { type: 'cancel'; id: string }
export type Status = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'steered' | 'interrupted'
export interface Message {
  id: string
  text: string
  status: Status
}
export type Reply = Extract<Event, { type: 'auth.status' | 'session.state' | 'error' }>
export type Event =
  | { type: 'auth.started'; attemptId: string; publicKey: JsonWebKey; expiresAt: number }
  | { type: 'auth.output'; attemptId: string; terminalSequence: number; iv: string; data: string }
  | {
      type: 'auth.finished'
      attemptId: string
      outcome: 'succeeded' | 'failed' | 'cancelled' | 'expired'
      authenticated: boolean
    }
  | { type: 'auth.error'; attemptId: string; code: string; activeAttemptId?: string }
  | { type: 'auth.reset' }
  | { type: 'auth.required'; id: string }
  | { type: 'auth.status'; authenticated: boolean }
  | { type: 'session.ready'; sessionId: string }
  | { type: 'session.state'; messages: Message[]; configured: boolean; truncated: boolean }
  | { type: 'message.status'; id: string; status: Status }
  | { type: 'claude'; id: string; event: unknown }
  | { type: 'claude.fragment'; id: string; eventId: string; index: number; total: number; json: string }
  | { type: 'error'; code: string }
