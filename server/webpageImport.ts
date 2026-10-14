import type { Actor, Frame } from '../shared/types.ts'
import * as actions from './actions.ts'
import { importedPageSource, importPage, normalizeImportUrl, type ImportedPage } from './importer.ts'

interface WebpageImportDependencies {
  importPage: typeof importPage
  createFrame: typeof actions.createFrame
}

const dependencies: WebpageImportDependencies = {
  importPage,
  createFrame: actions.createFrame,
}

export interface ImportedWebpageFrame {
  imported: ImportedPage
  frame: Frame | undefined
}

/** Find an earlier snapshot of the same requested URL. Resident pipeline
 *  stages use this to reuse source material instead of adding megabyte-scale
 *  duplicates on every stage or retry. */
export function findImportedWebpageFrame(frames: Frame[], rawUrl: string): Frame | undefined {
  const source = normalizeImportUrl(rawUrl).href
  return frames.find((frame) => importedPageSource(frame.html) === source)
}

/** Shared agent-facing wrapper around the browser/UI importer. Keeping the
 *  page-to-frame mapping here ensures resident and connected agents create the
 *  exact same editable source artifact. Dependencies are injectable for a
 *  bounded unit test without launching Chrome or writing to the store. */
export async function createImportedWebpageFrame(
  input: {
    canvasId: string
    url: string
    actor: Actor
    includePreview?: boolean
  },
  deps: WebpageImportDependencies = dependencies,
): Promise<ImportedWebpageFrame> {
  const imported = await deps.importPage(input.url, { includePreview: input.includePreview })
  const frame = await deps.createFrame(
    input.canvasId,
    {
      name: imported.title.slice(0, 80),
      width: imported.width,
      height: imported.height,
      html: imported.html,
    },
    input.actor,
  )
  return { imported, frame }
}
