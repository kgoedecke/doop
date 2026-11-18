import { unclosedUseRefusal } from './components.ts'
import { unclosedUses } from './componentEngine.ts'
import { repairEscapedHtml } from './escapedHtml.ts'
import { inlineDataRefusal, type Surface } from './inlineData.ts'

/* an edit lands on the stream's unfinished document: the open tag is the stream's own, which its
   next chunks close, so the editor is told to wait rather than to close it in a guessed place */
const STILL_STREAMING =
  'Refused, nothing was written: this frame is still streaming, and the stream has a <doop-use> open that its next chunks will close. Saved now, it would be placed with no slot content. Wait for the stream to finish, or replace the whole design with set_frame_html.'

/** The checks every whole-frame agent write passes before anything is saved: create, set and
 *  edit. A stream's chunks are partial by design and take only the inline-data check; its last
 *  chunk is checked in append_frame_html, on `streamedDocument`. The component check reads the
 *  document as it would be saved, an escaped one decoded. `streamed` is a frame's HTML while an
 *  agent streams into it, for an edit made on top of it. */
export function frameWriteRefusal(
  submitted: string,
  existing = '',
  surface: Surface = 'mcp',
  streamed = '',
): string | null {
  const inline = inlineDataRefusal(submitted, existing, surface)
  if (inline) return inline
  const unclosed = unclosedUseRefusal(repairEscapedHtml(submitted))
  return unclosed && unclosedUses(streamed).length ? STILL_STREAMING : unclosed
}
