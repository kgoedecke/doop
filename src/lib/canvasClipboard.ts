import { nanoid } from 'nanoid'
import { useStore } from './store'
import { t } from './i18n'

const TOKEN_KEY = 'doop:clipboard-token'

/** Replace the saved selection only after the system clipboard accepts the write. */
export function writeCanvasClipboard(copy: () => boolean | void, data?: DataTransfer): boolean {
  const token = `doop:clipboard:${nanoid()}`
  const failed = () => {
    useStore.getState().pushNotice(t('stage.copyClipboardFailed'))
  }
  const commit = () => {
    if (copy() === false) return false
    localStorage.setItem(TOKEN_KEY, token)
    return true
  }
  try {
    if (data) {
      data.setData('text/plain', token)
      return commit()
    }
    if (!navigator.clipboard) {
      failed()
      return false
    }
    navigator.clipboard
      .writeText(token)
      .then(() => {
        if (!commit()) failed()
      })
      .catch(failed)
    return true
  } catch {
    failed()
    return false
  }
}

export function isCanvasClipboard(data: DataTransfer | null): boolean {
  const token = localStorage.getItem(TOKEN_KEY)
  return !!token && data?.getData('text/plain') === token
}
