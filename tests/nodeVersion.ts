import { readFileSync } from 'node:fs'

/* The suite spawns its servers with the Node running vitest (process.execPath), and on an older
   major they fail to start with nothing better than "server did not bind". .node-version is the
   version CI, the Docker images and production run; the suite asks for its major, at that release
   or later. */

type Version = [number, number, number]

function parse(version: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function atLeast(running: Version, wanted: Version): boolean {
  for (const [index, part] of running.entries()) {
    const other = wanted[index] ?? 0
    if (part !== other) return part > other
  }
  return true
}

/** What is wrong with running the suite on `running` when .node-version says `wanted`, or null. */
export function nodeVersionProblem(wanted: string, running: string): string | null {
  const want = parse(wanted)
  const have = parse(running)
  if (!want || !have) return null
  if (have[0] === want[0] && atLeast(have, want)) return null
  return (
    `The tests need Node ${want[0]} (${want.join('.')} or later, from .node-version) and this is Node ${have.join('.')}. ` +
    `Switch first (nvm-windows: \`nvm install ${want.join('.')}\` then \`nvm use ${want.join('.')}\`; fnm: \`fnm use\`).`
  )
}

export function requireNodeVersion(): void {
  const wanted = readFileSync(new URL('../.node-version', import.meta.url), 'utf8')
  const problem = nodeVersionProblem(wanted, process.version)
  if (problem) throw new Error(problem)
}
