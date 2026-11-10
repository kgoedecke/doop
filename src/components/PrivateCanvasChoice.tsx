import { useEffect, useState } from 'react'
import type { CanvasMeta } from '../../shared/types'
import { api, errorMessage } from '../lib/api'
import { Note } from './ui/note'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

/** A visible storage choice: private files never acquire an implicit parent. */
export function PrivateCanvasChoice({
  value,
  onChange,
  workspaceId,
  disabled,
}: {
  value: string
  onChange(value: string): void
  workspaceId?: string
  disabled?: boolean
}) {
  const [canvases, setCanvases] = useState<CanvasMeta[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    api.listCanvases().then(
      (list) => {
        if (live) setCanvases(list.filter((c) => !workspaceId || c.workspaceId === workspaceId))
      },
      (reason: unknown) => {
        if (live) setError(errorMessage(reason, 'The canvas list could not be loaded.'))
      },
    )
    return () => {
      live = false
    }
  }, [workspaceId])
  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-body">
        Store files in canvas
        <Select value={value} disabled={disabled || !canvases.length} onValueChange={onChange}>
          <SelectTrigger aria-label="Store files in canvas">
            <SelectValue placeholder="Choose a canvas" />
          </SelectTrigger>
          <SelectContent>
            {canvases.map((canvas) => (
              <SelectItem key={canvas.id} value={canvas.id}>
                {canvas.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <Note>
        Only people with current access to this canvas can load these files. Create a canvas first if the list is empty.
      </Note>
      {error && <Note tone="error">{error}</Note>}
    </div>
  )
}
