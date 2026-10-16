import { vi } from 'vitest'
import { reloadEnv } from '../server/env.ts'

/**
 * server/env.ts parses process.env once at import. A test that changes a
 * variable afterwards must re-parse for the change to reach `env`; these
 * wrappers pair vitest's env stubs with that re-parse. Only reads that happen
 * inside a function see the new value — a module-level constant keeps what it
 * read at import (use vi.resetModules() and a fresh import for those).
 */
export function stubEnv(name: string, value: string | undefined): void {
  vi.stubEnv(name, value)
  reloadEnv()
}

/** Undo every stubEnv of the test; pair with it in afterEach. */
export function unstubAllEnvs(): void {
  vi.unstubAllEnvs()
  reloadEnv()
}
