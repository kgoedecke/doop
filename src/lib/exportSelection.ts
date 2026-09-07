import { useDesignEditor } from './designEditor'
import { useStore } from './store'

/** Wait for the selected layer's bounds and any pending design saves, rather
 * than silently exporting its whole frame while inspection is loading. */
export function useExportSelectionReady() {
  const selection = useDesignEditor((s) => s.selection)
  const busy = useDesignEditor((s) => s.busy)
  const selectedIds = useStore((s) => s.selectedIds)
  const element = useStore((s) => s.selectedElement)
  return (
    !busy &&
    selectedIds.length > 0 &&
    (selectedIds.length > 1 ||
      !selection ||
      selection.frameId !== selectedIds[0] ||
      element?.frameId === selection.frameId)
  )
}
