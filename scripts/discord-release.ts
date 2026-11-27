/**
 * Announces a release in Discord: the release's section of a CHANGELOG.md that release-please wrote, shortened to fit
 * one embed and posted to a channel webhook. release-please.yml runs it when it cuts a web release, and
 * desktop-release.yml once a desktop release has its installers.
 *
 * DISCORD_RELEASE_WEBHOOK_URL is the channel's webhook (Discord: the channel's settings, Integrations, Webhooks).
 * Without it the message is printed and nothing is posted, so a fork or a dry run needs no secret.
 *
 * Usage: node scripts/discord-release.ts --title 'Doop v0.16.0' --url <release page> --changelog CHANGELOG.md --version 0.16.0
 */

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

export interface ChangelogSection {
  heading: string
  entries: string[]
}

export interface DiscordMessage {
  allowed_mentions: { parse: never[] }
  embeds: { title: string; url: string; color: number; description?: string }[]
}

/** Discord's cap on an embed's description */
export const DESCRIPTION_LIMIT = 4096
const BRAND = 0x0177d3
const USAGE =
  'Usage: node scripts/discord-release.ts --title <title> --url <release page> --changelog <file> --version <x.y.z>'

/** What release-please wrote for `version`, a section per `###` heading in the file's order; [] when it has no entry. */
export function changelogSection(markdown: string, version: string): ChangelogSection[] {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => versionOf(line) === version)
  if (start < 0) return []
  const sections: ChangelogSection[] = []
  for (const line of lines.slice(start + 1)) {
    if (versionOf(line) !== undefined) break
    const heading = /^###\s+(.+)$/.exec(line)?.[1]
    if (heading) sections.push({ heading: heading.trim(), entries: [] })
    const entry = /^\* (.+)$/.exec(line)?.[1]
    if (entry) sections.at(-1)?.entries.push(plainEntry(entry))
  }
  return sections.filter(({ entries }) => entries.length > 0)
}

/** The webhook body: one embed titled and linked to the release, its notes as short as Discord needs them. */
export function discordMessage(release: { title: string; url: string; sections: ChangelogSection[] }): DiscordMessage {
  const description = describe(release.sections, release.url)
  return {
    // a release note naming @everyone or a role must not ping anyone
    allowed_mentions: { parse: [] },
    embeds: [{ title: release.title, url: release.url, color: BRAND, ...(description ? { description } : {}) }],
  }
}

/** `## [0.15.0](compare link) (date)`, or `## 0.1.0 (date)` for a first release: the version a line heads, if any. */
function versionOf(line: string): string | undefined {
  return /^##\s+\[?v?([^\]\s)]+)/.exec(line)?.[1]
}

/** An entry without its PR and commit links, and with any other link as its text. */
function plainEntry(entry: string): string {
  const trailingLink = /\s*\(\[[^\]]*\]\([^)]*\)\)\s*$/
  let text = entry
  while (trailingLink.test(text)) text = text.replace(trailingLink, '')
  return text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim()
}

/** The sections as bold headings over bullets; past the limit, whole entries in order and a count of the rest. */
function describe(sections: ChangelogSection[], url: string): string {
  const total = sections.reduce((count, { entries }) => count + entries.length, 0)
  const block = ({ heading, entries }: ChangelogSection) =>
    [`**${heading}**`, ...entries.map((e) => `- ${e}`)].join('\n')
  const whole = sections.map(block).join('\n\n')
  if (whole.length <= DESCRIPTION_LIMIT) return whole

  const room = DESCRIPTION_LIMIT - `\n\n${moreLine(total, url)}`.length
  let text = ''
  let shown = 0
  for (const { heading, entries } of sections) {
    let candidate = text ? `${text}\n\n**${heading}**` : `**${heading}**`
    let fits = 0
    for (const entry of entries) {
      const next = `${candidate}\n- ${entry}`
      if (next.length > room) break
      candidate = next
      fits += 1
    }
    // a heading goes out only with an entry under it
    if (fits === 0) break
    text = candidate
    shown += fits
    if (fits < entries.length) break
  }
  return text ? `${text}\n\n${moreLine(total - shown, url)}` : moreLine(total, url)
}

function moreLine(count: number, url: string): string {
  return `…and ${count} more in the [release notes](${url}).`
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      title: { type: 'string' },
      url: { type: 'string' },
      changelog: { type: 'string' },
      version: { type: 'string' },
    },
  })
  const { title, url, changelog, version } = values
  if (!title || !url || !changelog || !version) {
    console.error(USAGE)
    process.exit(2)
  }
  const sections = changelogSection(readFileSync(changelog, 'utf8'), version.replace(/^v/, ''))
  if (sections.length === 0) console.log(`::warning::${changelog} has no notes for ${version}; posting the link alone`)
  const message = discordMessage({ title, url, sections })

  const webhook = process.env.DISCORD_RELEASE_WEBHOOK_URL
  if (!webhook) {
    console.log('DISCORD_RELEASE_WEBHOOK_URL is not set, so nothing is posted. The message would be:')
    console.log(JSON.stringify(message, null, 2))
    return
  }
  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  })
  if (!response.ok) throw new Error(`Discord answered ${response.status}: ${await response.text()}`)
  console.log(`Posted "${title}" to Discord`)
}

if (import.meta.main) await main()
