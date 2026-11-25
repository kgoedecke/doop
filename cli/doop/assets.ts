import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { callJson } from './client.ts'
import type { Context, Outcome } from './context.ts'
import { CliError, EXIT, usage } from './errors.ts'

/**
 * `doop asset upload`: a file on this machine, or a public URL, into Doop's asset store. Frames
 * carry markup and never files, so an image goes up first and the frame references the URL that
 * comes back. A local file takes the server's one-time upload ticket, which this fills itself.
 */

interface Uploaded {
  url: string
  mime?: string
  size_bytes?: number
}

async function uploadFile(context: Context, canvasId: string, path: string): Promise<Uploaded> {
  if (!existsSync(path)) throw new CliError(`${path} does not exist`, EXIT.notFound)
  const ticket = await callJson<{ upload_url: string }>(context.connection, 'upload_asset', {
    canvas_id: canvasId,
    local_file: true,
  })
  context.heard(ticket.result)
  const response = await fetch(ticket.value.upload_url, { method: 'PUT', body: readFileSync(path) })
  const answer = (await response.json().catch(() => ({}))) as Uploaded & { error?: string }
  if (!response.ok || !answer.url) throw new CliError(`upload of ${path} failed: ${answer.error ?? response.status}`)
  return answer
}

export async function asset(context: Context): Promise<Outcome> {
  const [action, ...sources] = context.args
  if (action !== 'upload' || !sources.length) throw usage('usage: doop asset upload <file or URL>…')
  const canvasId = context.canvasId()
  const uploaded: (Uploaded & { source: string })[] = []
  /* one at a time: uploads are rate-limited per account */
  for (const source of sources) {
    if (/^https?:\/\//.test(source)) {
      const fetched = await callJson<Uploaded>(context.connection, 'upload_asset', {
        canvas_id: canvasId,
        source_url: source,
      })
      context.heard(fetched.result)
      uploaded.push({ ...fetched.value, source })
    } else uploaded.push({ ...(await uploadFile(context, canvasId, resolve(context.cwd, source))), source })
  }
  return {
    text: uploaded.map((entry) => `${entry.url}\t${entry.source}`).join('\n'),
    data: { assets: uploaded.map(({ source, url, mime, size_bytes }) => ({ source, url, mime, size_bytes })) },
  }
}
