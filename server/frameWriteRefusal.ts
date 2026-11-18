import { unclosedUseRefusal } from './components.ts'
import { repairEscapedHtml } from './escapedHtml.ts'
import { inlineDataRefusal, type Surface } from './inlineData.ts'

/** The checks every whole-frame agent write passes before anything is saved (create, set and
 *  edit; a stream's chunks are partial by design and take only the inline-data check, until the
 *  last makes the document whole). The component check reads the document as it would be saved,
 *  an escaped one decoded. */
export function frameWriteRefusal(submitted: string, existing = '', surface: Surface = 'mcp'): string | null {
  return inlineDataRefusal(submitted, existing, surface) ?? unclosedUseRefusal(repairEscapedHtml(submitted))
}
