/** Exit codes a script or an agent can branch on; `doop help` lists them. */
export const EXIT = {
  error: 1,
  usage: 2,
  /** the canvas and the local file both changed since the last pull */
  conflict: 3,
  auth: 4,
  notFound: 5,
  timeout: 6,
} as const

/** A failure with the command to run next, so an agent can recover without guessing. */
export class CliError extends Error {
  readonly exitCode: number
  readonly hint: string | undefined

  constructor(message: string, exitCode: number = EXIT.error, hint?: string) {
    super(message)
    this.exitCode = exitCode
    this.hint = hint
  }
}

export function usage(message: string, hint?: string): CliError {
  return new CliError(message, EXIT.usage, hint)
}
