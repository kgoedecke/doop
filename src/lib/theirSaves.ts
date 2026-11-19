/* The newest version of each frame that someone else saved (a teammate, an
   agent, another tab), as the room reported it. Undo and redo of a guarded
   step read it to tell another person's save from this browser's own:
   timestamps alone cannot, since this browser's later steps, and their undo,
   raise them too. */
const theirs = new Map<string, number>()

export function noteTheirSave(frameId: string, updatedAt: number) {
  if ((theirs.get(frameId) ?? -Infinity) < updatedAt) theirs.set(frameId, updatedAt)
}

/** whether someone else saved the frame after `version` */
export function savedByOthersSince(frameId: string, version: number): boolean {
  return (theirs.get(frameId) ?? -Infinity) > version
}
