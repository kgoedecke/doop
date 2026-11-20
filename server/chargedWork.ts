/**
 * Work a resident task was charged for before it ran (a comment that @mentions an agent): when
 * the work fails (rejects) or makes nothing (answers undefined), the task is given back, so a
 * failed request never costs the person a task. A refund that fails is logged, never turned
 * into the request's failure. With no charge (`gate` undefined) the work just runs.
 */
export async function refundUnlessDone<G, T>(
  gate: G | undefined,
  refund: (gate: G) => Promise<void>,
  work: () => Promise<T | undefined>,
  what: string,
): Promise<T | undefined> {
  const giveBack = async () => {
    if (!gate) return
    await refund(gate).catch((err: unknown) => console.error(`[allowance] could not refund a task for ${what}:`, err))
  }
  let done: T | undefined
  try {
    done = await work()
  } catch (error) {
    await giveBack()
    throw error
  }
  if (done === undefined) await giveBack()
  return done
}
