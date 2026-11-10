import { parentPort, workerData } from 'node:worker_threads'
import { validateMedia, type MediaInput } from './privateMediaFiles.ts'
import { PrivateMaterializationError, PrivateMediaBudget } from '../shared/privateMedia.ts'
import { makeMediaPreview } from './privateMediaPreview.ts'

if (!parentPort) throw new Error('private media decoder requires its worker port')
const port = parentPort
let next = 0
const reservations = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
port.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'admitted') return
  const value = message as { id?: unknown; accepted?: unknown }
  if (typeof value.id !== 'number') return
  const reservation = reservations.get(value.id)
  if (!reservation) return
  reservations.delete(value.id)
  if (value.accepted === true) reservation.resolve()
  else reservation.reject(new PrivateMaterializationError('limit'))
})

async function reserve(cost: import('./privateMediaFiles.ts').MediaAdmission): Promise<void> {
  const id = next++
  await new Promise<void>((resolve, reject) => {
    reservations.set(id, { resolve, reject })
    port.postMessage({ type: 'admit', id, cost })
  })
}

try {
  const request: unknown = workerData
  if (!request || typeof request !== 'object' || !('operation' in request))
    throw new PrivateMaterializationError('invalid')
  const budget = new PrivateMediaBudget()
  if (request.operation === 'preview') {
    if (!('bytes' in request) || !(request.bytes instanceof Uint8Array))
      throw new PrivateMaterializationError('invalid')
    budget.chargeEncoded(request.bytes.byteLength)
    const result = await makeMediaPreview(request.bytes, async (cost) => {
      budget.chargeDecoded(cost.decodedBytes)
      await reserve(cost)
    })
    port.postMessage({ type: 'complete', result })
  } else {
    if (
      request.operation !== 'validate' ||
      !('items' in request) ||
      !('parserWork' in request) ||
      typeof request.parserWork !== 'number'
    )
      throw new PrivateMaterializationError('invalid')
    const items: unknown = request.items
    if (!Array.isArray(items)) throw new PrivateMaterializationError('invalid')
    budget.chargeWork(request.parserWork)
    for (const item of items) {
      if (!item || typeof item !== 'object' || !(item.bytes instanceof Uint8Array) || typeof item.mime !== 'string')
        throw new PrivateMaterializationError('invalid')
      budget.reference()
      budget.chargeEncoded(item.bytes.byteLength)
    }
    const results = []
    for (const item of items as MediaInput[]) {
      const result = await validateMedia(
        item,
        async (cost) => {
          budget.chargeDecoded(cost.decodedBytes)
          await reserve(cost)
        },
        (count) => budget.chargeWork(count),
      )
      results.push(result)
    }
    port.postMessage({ type: 'complete', result: results })
  }
} catch (error) {
  // No native parser errors, file contents, paths or diagnostics cross the boundary.
  port.postMessage({ type: 'failed', kind: error instanceof PrivateMaterializationError ? error.kind : 'invalid' })
} finally {
  port.close()
}
