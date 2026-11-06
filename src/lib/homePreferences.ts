import { useSyncExternalStore } from 'react'

/** Like the theme, dashboard preferences belong to this browser. */
export const PROMPT_BOX_STORAGE_KEY = 'doop.home.prompt-box-hidden'

let hidden: boolean | undefined
const listeners = new Set<() => void>()

function getHidden(): boolean {
  if (hidden === undefined) {
    try {
      hidden = localStorage.getItem(PROMPT_BOX_STORAGE_KEY) === 'true'
    } catch {
      hidden = false
    }
  }
  return hidden
}

function notify() {
  listeners.forEach((listener) => listener())
}

function onStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== PROMPT_BOX_STORAGE_KEY) return
  hidden = undefined
  notify()
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    window.addEventListener('storage', onStorage)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener('storage', onStorage)
  }
}

export function setPromptBoxHidden(value: boolean) {
  hidden = value
  try {
    localStorage.setItem(PROMPT_BOX_STORAGE_KEY, String(value))
  } catch {
    // The preference still works for this session if storage is unavailable.
  }
  notify()
}

export function usePromptBoxHidden(): boolean {
  return useSyncExternalStore(subscribe, getHidden)
}
