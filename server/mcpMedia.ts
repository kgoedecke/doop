import { PrivateMediaBudget } from '../shared/privateMedia.ts'
import { runMaterializationJob } from './materializationJob.ts'
import { prepareMediaPreview } from './privateMediaValidation.ts'
import { assertRenderRead, type PrivateRenderScope } from './privateResources.ts'

/** Acquire only after rendering finishes: a renderer needs this same admission. */
export function privateMcpImage(bytes: Uint8Array, scope: PrivateRenderScope) {
  return runMaterializationJob(async (job) => {
    await job.read(() => assertRenderRead(scope))
    const budget = new PrivateMediaBudget()
    budget.chargeEncoded(bytes.byteLength)
    const result = await prepareMediaPreview(job, bytes, (cost) => budget.chargeDecoded(cost.decodedBytes))
    await job.read(() => assertRenderRead(scope))
    return result
  })
}
