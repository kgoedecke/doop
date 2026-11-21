import type { Frame } from '../shared/types.ts'
import type * as Screenshot from '../server/screenshot.ts'

/* Holds server/screenshot.ts's measureContent at its start until the test lets it go,
   so a test can change a frame while a fit is measuring without racing a timer. A test file
   mocks the module with it:
     vi.mock('../server/screenshot.ts', async (importOriginal) =>
       (await import('./measureGate.ts')).gatedScreenshot(await importOriginal()))
*/

interface Gate {
  reached: () => void
  released: Promise<void>
}

let next: Gate | undefined

export function gatedScreenshot(real: typeof Screenshot): typeof Screenshot {
  async function measureContent<T>(frame: Frame, settle: (probe: Screenshot.ContentProbe) => Promise<T>): Promise<T> {
    const gate = next
    next = undefined
    if (gate) {
      gate.reached()
      await gate.released
    }
    return real.measureContent(frame, settle)
  }
  return { ...real, measureContent }
}

/** The next measure waits: `reached` settles once it has started, `release` lets it go on. */
export function holdNextMeasure(): { reached: Promise<void>; release: () => void } {
  let reached = () => {}
  let release = () => {}
  const started = new Promise<void>((resolve) => (reached = resolve))
  const released = new Promise<void>((resolve) => (release = resolve))
  next = { reached, released }
  return { reached: started, release }
}
