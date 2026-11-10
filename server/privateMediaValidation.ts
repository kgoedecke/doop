import { Worker } from 'node:worker_threads'
import type { MaterializationJob } from './materializationJob.ts'
import type { MediaInput, MediaAdmission } from './privateMediaFiles.ts'
import { MAX_INLINE_MCP_MEDIA_BYTES, PrivateMaterializationError } from '../shared/privateMedia.ts'
import type { McpMediaPreview } from './privateMediaPreview.ts'

/** A job starts one serial decoder and owns it until actual exit, including
 * termination after its caller has already timed out. Never resolve on message. */
export function validateMediaInputs(
  job: MaterializationJob,
  items: readonly MediaInput[],
  admit: (cost: MediaAdmission) => void,
  parserWork = 0,
): Promise<readonly MediaAdmission[]> {
  return runMediaWorker(job, { operation: 'validate', items, parserWork }, admit, (value) => {
    if (!Array.isArray(value) || value.length !== items.length) throw new PrivateMaterializationError('invalid')
    return value as MediaAdmission[]
  })
}

export function prepareMediaPreview(
  job: MaterializationJob,
  bytes: Uint8Array,
  admit: (cost: MediaAdmission) => void,
): Promise<McpMediaPreview> {
  return runMediaWorker(job, { operation: 'preview', bytes }, admit, (value) => {
    const result = value as McpMediaPreview | undefined
    if (
      !result ||
      !(result.bytes instanceof Uint8Array) ||
      !result.bytes.length ||
      result.bytes.length > MAX_INLINE_MCP_MEDIA_BYTES ||
      !['image/png', 'image/jpeg'].includes(result.mime) ||
      ![result.width, result.height, result.fullWidth, result.fullHeight].every(
        (size) => Number.isSafeInteger(size) && size > 0,
      ) ||
      typeof result.fullResolution !== 'boolean'
    )
      throw new PrivateMaterializationError('invalid')
    return result
  })
}

function runMediaWorker<T>(
  job: MaterializationJob,
  request: object,
  admit: (cost: MediaAdmission) => void,
  parse: (value: unknown) => T,
): Promise<T> {
  return job.read(
    () =>
      new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./privateMediaWorker.mjs', import.meta.url), {
          workerData: request,
          execArgv: ['--import', import.meta.resolve('tsx')],
        })
        let failure: Error | undefined
        let result: T | undefined
        const terminate = (error: Error) => {
          failure ??= error
          void worker.terminate().catch(() => {
            // A failed termination request does not transfer the job's permit.
          })
        }
        const unsubscribe = job.onCancel(() => terminate(new PrivateMaterializationError('aborted')))
        worker.on('message', (message: unknown) => {
          if (failure || job.signal.aborted) return
          if (!message || typeof message !== 'object' || !('type' in message)) {
            terminate(new PrivateMaterializationError('invalid'))
            return
          }
          try {
            job.check()
            if (message.type === 'admit') {
              const request = message as { id?: unknown; cost?: unknown }
              if (
                typeof request.id !== 'number' ||
                !request.cost ||
                typeof request.cost !== 'object' ||
                !('decodedBytes' in request.cost) ||
                typeof request.cost.decodedBytes !== 'number'
              )
                throw new PrivateMaterializationError('invalid')
              admit(request.cost as MediaAdmission)
              job.check()
              worker.postMessage({ type: 'admitted', id: request.id, accepted: true })
            } else if (message.type === 'complete' && 'result' in message) {
              result = parse(message.result)
            } else if (
              message.type === 'failed' &&
              'kind' in message &&
              ['invalid', 'limit', 'unsupported', 'aborted'].includes(String(message.kind))
            ) {
              failure = new PrivateMaterializationError(message.kind as 'invalid' | 'limit' | 'unsupported' | 'aborted')
            } else throw new PrivateMaterializationError('invalid')
          } catch (error) {
            terminate(error instanceof PrivateMaterializationError ? error : new PrivateMaterializationError('invalid'))
          }
        })
        worker.on('error', () => {
          failure ??= new PrivateMaterializationError('invalid')
        })
        worker.once('exit', (code) => {
          unsubscribe()
          if (failure) reject(failure)
          else if (code !== 0 || result === undefined) reject(new PrivateMaterializationError('invalid'))
          else resolve(result)
        })
      }),
  )
}
