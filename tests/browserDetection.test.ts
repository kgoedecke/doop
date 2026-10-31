import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const config = { chromePath: undefined as string | undefined, directories: [] as string[] }
const originalPlatform = process.platform
let root: string

beforeEach(() => {
  vi.resetModules()
  vi.doMock('../server/env.ts', () => ({
    env: {
      get CHROME_PATH() {
        return config.chromePath
      },
    },
    windowsBrowserDirectories: () => config.directories,
  }))
  config.chromePath = undefined
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'doop-browser-test-'))
  config.directories = ['program-files', 'program-files-x86', 'local-app-data'].map((dir) => path.join(root, dir))
  Object.defineProperty(process, 'platform', { value: 'win32' })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  vi.doUnmock('../server/env.ts')
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

function installBrowser(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '')
  fs.chmodSync(file, 0o755)
  return file
}

async function detectBrowser(systemBrowser?: string): Promise<string | null> {
  const { findBrowserPath } = await import('../server/screenshot.ts')
  const access = fs.accessSync.bind(fs)
  vi.spyOn(fs, 'accessSync').mockImplementation((candidate, mode) => {
    if (candidate === systemBrowser) return
    if (!String(candidate).startsWith(root + path.sep)) throw new Error('outside test directory')
    access(candidate, mode)
  })
  return findBrowserPath()
}

describe('browser detection', () => {
  it.each(['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'])(
    'finds Chrome using the %s directory',
    async (directoryVariable) => {
      vi.doUnmock('../server/env.ts')
      vi.stubEnv('CHROME_PATH', undefined)
      vi.stubEnv('PROGRAMFILES', undefined)
      vi.stubEnv('PROGRAMFILES(X86)', undefined)
      vi.stubEnv('LOCALAPPDATA', undefined)
      vi.stubEnv(directoryVariable, config.directories[0]!)
      const chrome = installBrowser(path.join(config.directories[0]!, 'Google', 'Chrome', 'Application', 'chrome.exe'))

      expect(await detectBrowser()).toBe(chrome)
    },
  )

  it('uses CHROME_PATH before an automatically detected browser', async () => {
    config.chromePath = installBrowser(path.join(root, 'custom-browser.exe'))
    installBrowser(path.join(config.directories[0]!, 'Google', 'Chrome', 'Application', 'chrome.exe'))

    expect(await detectBrowser()).toBe(config.chromePath)
  })

  it('prefers a per-user Chrome over a system Edge', async () => {
    const chrome = installBrowser(path.join(config.directories[2]!, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    installBrowser(path.join(config.directories[0]!, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))

    expect(await detectBrowser()).toBe(chrome)
  })

  it('falls back to a detected browser when CHROME_PATH is unavailable', async () => {
    config.chromePath = path.join(root, 'missing-browser.exe')
    const edge = installBrowser(path.join(config.directories[1]!, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))

    expect(await detectBrowser()).toBe(edge)
  })

  it('uses Brave when Chrome and Edge are unavailable', async () => {
    const brave = installBrowser(
      path.join(config.directories[0]!, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    )

    expect(await detectBrowser()).toBe(brave)
  })

  it('returns null when no browser is available', async () => {
    expect(await detectBrowser()).toBeNull()
  })

  it.each([
    ['darwin', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    ['linux', '/usr/bin/chromium'],
  ])('finds a supported browser on %s: %s', async (platform, browserPath) => {
    Object.defineProperty(process, 'platform', { value: platform })

    expect(await detectBrowser(browserPath)).toBe(browserPath)
  })

  it.each(['linux', 'darwin'])('does not inspect Windows paths on %s', async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform })
    installBrowser(path.join(config.directories[0]!, 'Google', 'Chrome', 'Application', 'chrome.exe'))

    expect(await detectBrowser()).toBeNull()
  })
})
