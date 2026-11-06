import { useSyncExternalStore } from 'react'
import { DEFAULT_EXPORT_SCALE, parseExportScale } from '../../shared/exportScale'
import type { FrameExportFormat } from './frameExport'

/** The last image export picked: a density and a format, which the
 *  Inspector's Export group and the Export dialogs start from. */
export interface ExportSettings {
  scale: number
  format: FrameExportFormat
}

/* Per browser, like the panel layout: someone who exports 3x posters
   wants 3x next time, on every canvas. */
export const EXPORT_SETTINGS_STORAGE_KEY = 'doop:export-settings'

const DEFAULTS: ExportSettings = { scale: DEFAULT_EXPORT_SCALE, format: 'png' }

function isFormat(value: unknown): value is FrameExportFormat {
  return value === 'png' || value === 'jpg' || value === 'svg'
}

/** A stored pick, each field falling back to the default on its own. */
export function readExportSettings(raw: string | null): ExportSettings {
  if (!raw) return DEFAULTS
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof ExportSettings, unknown>>
    return {
      scale: parseExportScale(parsed.scale) ?? DEFAULTS.scale,
      format: isFormat(parsed.format) ? parsed.format : DEFAULTS.format,
    }
  } catch {
    return DEFAULTS
  }
}

/* A pick storage would not take holds for this session. The snapshot is
   kept per stored string, so React sees one object until the pick changes. */
let unsaved: ExportSettings | null = null
let cached: { raw: string | null; settings: ExportSettings } | null = null
const listeners = new Set<() => void>()

export function getExportSettings(): ExportSettings {
  if (unsaved) return unsaved
  let raw: string | null = null
  try {
    raw = localStorage.getItem(EXPORT_SETTINGS_STORAGE_KEY)
  } catch {
    /* storage unavailable: the default stands */
  }
  if (cached?.raw !== raw) cached = { raw, settings: readExportSettings(raw) }
  return cached.settings
}

export function setExportSettings(patch: Partial<ExportSettings>): void {
  const next = { ...getExportSettings(), ...patch }
  try {
    localStorage.setItem(EXPORT_SETTINGS_STORAGE_KEY, JSON.stringify(next))
    unsaved = null
  } catch {
    unsaved = next
  }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (e: StorageEvent) => {
    if (e.key !== EXPORT_SETTINGS_STORAGE_KEY) return
    unsaved = null
    listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function useExportSettings(): ExportSettings {
  return useSyncExternalStore(subscribe, getExportSettings)
}
