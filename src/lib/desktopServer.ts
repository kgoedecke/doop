/**
 * Which Doop server the desktop shell opens (desktop/src-tauri/src/server.rs).
 * The sign-in screen's server settings read it with `server_status` and change
 * it with `server_choose`: the shell checks the address answers as a Doop
 * server, asks the person in a native dialog, saves it and restarts onto it.
 * Shells advertise this with `__DOOP_SERVER_CHOOSE__`; browsers and older
 * shells never see the settings.
 */

export interface ServerStatus {
  /** the server this window opened, as an origin */
  url: string
  /** the one the app opens with nothing chosen (doop.design) */
  defaultUrl: string
  /** another server than the default is chosen */
  custom: boolean
}

type Bridge = {
  __DOOP_SERVER_CHOOSE__?: boolean
  __TAURI__?: { core?: { invoke?: <T>(command: string, args?: Record<string, unknown>) => Promise<T> } }
}
const bridge = globalThis as Bridge

export const canChooseServer = () => bridge.__DOOP_SERVER_CHOOSE__ === true && !!bridge.__TAURI__?.core?.invoke

function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const call = canChooseServer() ? bridge.__TAURI__?.core?.invoke : undefined
  if (!call) return Promise.reject(new Error('Update the Doop desktop app to change its server.'))
  return call<T>(command, args)
}

export function serverStatus(): Promise<ServerStatus> {
  return invoke<ServerStatus>('server_status')
}

/** Resolves true when the app is restarting onto `url`, false when nothing
 *  changed (the same server, or the person cancelled the dialog). Rejects
 *  with the shell's reason: not an address, or no Doop server answered. */
export function chooseServer(url: string): Promise<boolean> {
  return invoke<boolean>('server_choose', { url })
}

/** The shell rejects with a plain string; anything else gets a generic line. */
export function serverErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error) return error
  if (error instanceof Error && error.message) return error.message
  return fallback
}

/** `https://doop.example.com` as `doop.example.com`. */
export function serverHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
