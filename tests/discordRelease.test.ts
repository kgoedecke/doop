import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { changelogSection, DESCRIPTION_LIMIT, discordMessage } from '../scripts/discord-release.ts'

const run = promisify(execFile)
const SCRIPT = path.resolve(import.meta.dirname, '../scripts/discord-release.ts')
const RELEASE_URL = 'https://github.com/doop-design/doop/releases/tag/v0.16.0'

const CHANGELOG = `# Changelog

## [0.16.0](https://github.com/doop-design/doop/compare/v0.15.0...v0.16.0) (2026-11-27)


### Features

* **agents:** custom agents ([#510](https://github.com/doop-design/doop/issues/510)) ([802d7a2](https://github.com/doop-design/doop/commit/802d7a2))
* describe hand-placed layers ([b04df14](https://github.com/doop-design/doop/commit/b04df14))


### Bug Fixes

* **canvas:** races from the [#261](https://github.com/doop-design/doop/issues/261) review ([#263](https://github.com/doop-design/doop/issues/263)) ([9319a7c](https://github.com/doop-design/doop/commit/9319a7c))

## [0.15.0](https://github.com/doop-design/doop/compare/v0.14.0...v0.15.0) (2026-11-16)


### Features

* **older:** not part of 0.16.0 ([5ce1770](https://github.com/doop-design/doop/commit/5ce1770))

## 0.1.0 (2026-08-01)


### Features

* first release ([a1b2c3d](https://github.com/doop-design/doop/commit/a1b2c3d))
`

describe('changelogSection', () => {
  it('reads the version asked for, without its PR and commit links', () => {
    expect(changelogSection(CHANGELOG, '0.16.0')).toEqual([
      { heading: 'Features', entries: ['**agents:** custom agents', 'describe hand-placed layers'] },
      { heading: 'Bug Fixes', entries: ['**canvas:** races from the #261 review'] },
    ])
    expect(changelogSection(CHANGELOG, '0.15.0')).toEqual([
      { heading: 'Features', entries: ['**older:** not part of 0.16.0'] },
    ])
  })

  it('reads a first release, whose heading has no compare link', () => {
    expect(changelogSection(CHANGELOG, '0.1.0')).toEqual([{ heading: 'Features', entries: ['first release'] }])
  })

  it('has nothing for a version the file does not list', () => {
    expect(changelogSection(CHANGELOG, '0.17.0')).toEqual([])
    expect(changelogSection(CHANGELOG, '0.16')).toEqual([])
  })
})

describe('discordMessage', () => {
  it('is one embed linked to the release, its sections as headings over bullets', () => {
    const message = discordMessage({
      title: 'Doop v0.16.0',
      url: RELEASE_URL,
      sections: changelogSection(CHANGELOG, '0.16.0'),
    })
    expect(message).toEqual({
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: 'Doop v0.16.0',
          url: RELEASE_URL,
          color: 0x0177d3,
          description:
            '**Features**\n- **agents:** custom agents\n- describe hand-placed layers\n\n' +
            '**Bug Fixes**\n- **canvas:** races from the #261 review',
        },
      ],
    })
  })

  it('is the title and link alone when the release has no notes', () => {
    const [embed] = discordMessage({ title: 'Doop v0.16.0', url: RELEASE_URL, sections: [] }).embeds
    expect(embed).toEqual({ title: 'Doop v0.16.0', url: RELEASE_URL, color: 0x0177d3 })
  })

  it('keeps whole entries within Discord’s limit and counts the ones left out', () => {
    const entries = (prefix: string) =>
      Array.from({ length: 40 }, (_, i) => `**${prefix}:** change number ${i} ${'x'.repeat(60)}`)
    const sections = [
      { heading: 'Features', entries: entries('feat') },
      { heading: 'Bug Fixes', entries: entries('fix') },
    ]
    const description =
      discordMessage({ title: 'Doop v0.16.0', url: RELEASE_URL, sections }).embeds[0]?.description ?? ''

    expect(description.length).toBeLessThanOrEqual(DESCRIPTION_LIMIT)
    const shown = description.split('\n').filter((line) => line.startsWith('- '))
    expect(shown.length).toBeGreaterThan(40)
    expect(shown.every((line) => line.endsWith('x'.repeat(60)))).toBe(true)
    expect(description).toMatch(/^\*\*Features\*\*\n/)
    expect(description).toContain('\n\n**Bug Fixes**\n- **fix:** change number 0 ')
    expect(description.endsWith(`\n\n…and ${80 - shown.length} more in the [release notes](${RELEASE_URL}).`)).toBe(
      true,
    )
  })

  it('does not leave a heading with nothing under it', () => {
    const long = `**feat:** ${'y'.repeat(3900)}`
    const sections = [
      { heading: 'Features', entries: [long] },
      { heading: 'Bug Fixes', entries: [long] },
    ]
    const description =
      discordMessage({ title: 'Doop v0.16.0', url: RELEASE_URL, sections }).embeds[0]?.description ?? ''
    expect(description).toBe(`**Features**\n- ${long}\n\n…and 1 more in the [release notes](${RELEASE_URL}).`)
  })
})

describe('the script', () => {
  const changelog = path.join(mkdtempSync(path.join(tmpdir(), 'discord-release-')), 'CHANGELOG.md')
  writeFileSync(changelog, CHANGELOG)
  const args = [
    SCRIPT,
    '--title',
    'Doop v0.16.0',
    '--url',
    RELEASE_URL,
    '--changelog',
    changelog,
    '--version',
    'v0.16.0',
  ]

  it('posts the message to the webhook', async () => {
    const received: { method?: string; type?: string; body: string }[] = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk: Buffer) => (body += chunk.toString()))
      request.on('end', () => {
        received.push({ method: request.method, type: request.headers['content-type'], body })
        response.writeHead(204).end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      const env = { ...process.env, DISCORD_RELEASE_WEBHOOK_URL: `http://127.0.0.1:${port}/webhook` }
      const { stdout } = await run(process.execPath, args, { env })

      expect(stdout).toContain('Posted "Doop v0.16.0" to Discord')
      expect(received).toHaveLength(1)
      expect(received[0]?.method).toBe('POST')
      expect(received[0]?.type).toBe('application/json')
      expect(JSON.parse(received[0]?.body ?? '')).toEqual(
        discordMessage({ title: 'Doop v0.16.0', url: RELEASE_URL, sections: changelogSection(CHANGELOG, '0.16.0') }),
      )
    } finally {
      server.close()
    }
  })

  it('fails when Discord refuses the message', async () => {
    const server = createServer((_request, response) => response.writeHead(400).end('{"message": "Invalid Form Body"}'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      const env = { ...process.env, DISCORD_RELEASE_WEBHOOK_URL: `http://127.0.0.1:${port}/webhook` }
      await expect(run(process.execPath, args, { env })).rejects.toMatchObject({
        stderr: expect.stringContaining('Discord answered 400: {"message": "Invalid Form Body"}'),
      })
    } finally {
      server.close()
    }
  })

  it('prints the message and posts nothing without a webhook', async () => {
    const env = { ...process.env, DISCORD_RELEASE_WEBHOOK_URL: '' }
    const { stdout } = await run(process.execPath, args, { env })
    expect(stdout).toContain('DISCORD_RELEASE_WEBHOOK_URL is not set, so nothing is posted')
    expect(stdout).toContain('"title": "Doop v0.16.0"')
  })
})
