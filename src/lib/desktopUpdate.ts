/* The desktop shell's update offer (desktop/src-tauri/src/updates.rs). Once
   the page listens for `update-ready` it tells the shell through
   `update_card_ready`, and from then on a downloaded update is offered here
   instead of in a native dialog; one already waiting comes back as its answer. Outside the shell, and in shells older than
   the card (no __DOOP_UPDATE_CARD__), nothing is listened for or sent. */

export const UPDATE_READY_EVENT = 'update-ready'

/** The version on offer and the one running. */
export type UpdateOffer = { version: string; current: string }

type UpdateBridge = {
  __DOOP_UPDATE_CARD__?: boolean
  __TAURI__?: {
    core?: { invoke?: (command: string) => Promise<unknown> }
    event?: { listen?: <T>(name: string, handler: (event: { payload: T }) => void) => Promise<() => void> }
  }
}

const bridge = globalThis as UpdateBridge

function shellTauri() {
  return bridge.__DOOP_UPDATE_CARD__ === true ? bridge.__TAURI__ : undefined
}

export function isUpdateOffer(value: unknown): value is UpdateOffer {
  const offer = value as Partial<UpdateOffer> | null
  return typeof offer?.version === 'string' && typeof offer.current === 'string'
}

/** Hand every update offer to `onOffer`; returns the unsubscribe. */
export function listenForUpdates(onOffer: (offer: UpdateOffer) => void): () => void {
  const tauri = shellTauri()
  const listen = tauri?.event?.listen
  if (!listen) return () => {}
  let unlisten: (() => void) | undefined
  let stopped = false
  listen<unknown>(UPDATE_READY_EVENT, (e) => {
    if (isUpdateOffer(e.payload)) onOffer(e.payload)
  })
    .then((off) => {
      if (stopped) return off()
      unlisten = off
      /* only once the listener is in place, so no offer falls between; a
         download already waiting (this page is a reload) comes back */
      return tauri.core?.invoke?.('update_card_ready')
    })
    .then((waiting) => {
      if (!stopped && isUpdateOffer(waiting)) onOffer(waiting)
    })
    .catch(console.error)
  return () => {
    stopped = true
    unlisten?.()
  }
}

/** Install the offered update and restart into it. Settles only when that
 *  failed (the shell has already said why); on success the app restarts. */
export async function restartToUpdate(): Promise<void> {
  await shellTauri()?.core?.invoke?.('update_restart')
}
