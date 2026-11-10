/* Test-only observation/rendezvous on PUBLIC Puppeteer APIs and actual disk reads.
   It changes neither policy nor returned pixels. Never loaded by production. */
import fs from 'node:fs'
import process from 'node:process'
import { setTimeout } from 'node:timers'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import puppeteer from 'puppeteer-core'

const root = process.env.DOOP_RENDER_RENDEZVOUS
if (root) {
  const event = (entry) => fs.appendFileSync(path.join(root, 'events.jsonl'), JSON.stringify(entry) + '\n')
  const control = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, 'control.json'), 'utf8'))
    } catch {
      return { hold: false }
    }
  }
  const read = fs.createReadStream.bind(fs)
  fs.createReadStream = (filename, ...args) => {
    if (String(filename).includes(`${path.sep}data${path.sep}assets${path.sep}`)) event({ kind: 'disk-read' })
    return read(filename, ...args)
  }
  syncBuiltinESMExports()
  const launch = puppeteer.launch.bind(puppeteer)
  puppeteer.launch = async (...args) => {
    const browser = await launch(...args)
    const createContext = browser.createBrowserContext.bind(browser)
    browser.createBrowserContext = async (...options) => {
      const context = await createContext(...options)
      const contextId = randomUUID()
      event({ kind: 'context-open', contextId })
      const close = context.close.bind(context)
      let closed = false
      context.close = async () => {
        try {
          return await close()
        } finally {
          if (!closed) {
            closed = true
            event({ kind: 'context-close', contextId })
          }
        }
      }
      const newPage = context.newPage.bind(context)
      context.newPage = async (...pageArgs) => {
        const page = await newPage(...pageArgs)
        for (const kind of ['screenshot', 'pdf']) {
          const render = page[kind].bind(page)
          page[kind] = async (...renderArgs) => {
            const bytes = await render(...renderArgs)
            const config = control()
            const held = config.hold && (!config.needle || (await page.content()).includes(config.needle))
            const id = randomUUID()
            event({ kind, id, contextId, held: !!held, digest: createHash('sha256').update(bytes).digest('hex') })
            if (held) {
              const deadline = Date.now() + (config.holdTimeoutMs ?? 20_000)
              while (!fs.existsSync(path.join(root, `release-${id}`)) && control().hold) {
                if (Date.now() >= deadline) throw new Error('test render rendezvous deadline exceeded')
                await new Promise((resolve) => setTimeout(resolve, 10))
              }
            }
            return bytes
          }
        }
        return page
      }
      return context
    }
    return browser
  }
}
