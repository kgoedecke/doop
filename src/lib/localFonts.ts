/**
 * Fonts from this computer, in the desktop shell: the shell opens the native
 * file panel in the fonts folder (desktop/src-tauri/src/fonts.rs), the page
 * reads each picked file once by the path the panel returned and uploads it
 * through the ordinary font upload, so a local font becomes a library font
 * every viewer and renderer gets. Shells advertise this with
 * `__DOOP_LOCAL_FONTS__`; browsers and older shells never see the button.
 */

export interface PickedLocalFont {
  path: string
  name: string
  size: number
}

export interface SkippedLocalFont {
  name: string
  /** not a single font file (a collection, or what the panel let through), or over the 10 MB limit */
  reason: 'kind' | 'size'
}

export interface LocalFontPick {
  picked: PickedLocalFont[]
  skipped: SkippedLocalFont[]
}

type Bridge = {
  __DOOP_LOCAL_FONTS__?: boolean
  __TAURI__?: { core: { invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> } }
}
const bridge = globalThis as Bridge

export const canAddLocalFonts = () => bridge.__DOOP_LOCAL_FONTS__ === true && !!bridge.__TAURI__?.core

function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!canAddLocalFonts())
    return Promise.reject(new Error('Update the Doop desktop app to add fonts from this computer.'))
  return bridge.__TAURI__!.core.invoke<T>(command, args)
}

/** Opens the panel; an empty pick is a cancel. */
export function pickLocalFonts(): Promise<LocalFontPick> {
  return invoke<LocalFontPick>('fonts_choose_local')
}

/** The picked file as a File the upload takes, read through the shell. */
export async function readLocalFont(font: PickedLocalFont): Promise<File> {
  const bytes = await invoke<ArrayBuffer>('fonts_read_local', { path: font.path })
  return localFontFile(font.name, bytes)
}

export function localFontFile(name: string, bytes: ArrayBuffer): File {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  const type = ext === 'woff2' || ext === 'woff' || ext === 'ttf' || ext === 'otf' ? `font/${ext}` : ''
  return new File([bytes], name, { type })
}
