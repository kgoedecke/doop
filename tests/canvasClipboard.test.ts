// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { isCanvasClipboard, writeCanvasClipboard } from '../src/lib/canvasClipboard'
import { useStore } from '../src/lib/store'
import { setLocale } from '../src/lib/i18n'

beforeEach(() => {
  localStorage.clear()
  useStore.setState({ notice: null })
  setLocale('en')
})

afterEach(() => vi.restoreAllMocks())

it.each([
  ['en', 'Couldn’t copy to the clipboard. Please try again.'],
  ['pt-BR', 'Não foi possível copiar para a área de transferência. Tente novamente.'],
] as const)(
  'reports a refused clipboard write in %s without replacing the saved selection',
  async (locale, message) => {
    setLocale(locale)
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('NotAllowedError'))
    const copy = vi.fn()
    writeCanvasClipboard(copy)
    const data = new DataTransfer()
    data.setData('text/plain', write.mock.calls[0]![0])
    await vi.waitFor(() => expect(useStore.getState().notice?.text).toBe(message))
    expect(copy).not.toHaveBeenCalled()
    expect(isCanvasClipboard(data)).toBe(false)
  },
)

it('does not invalidate a newer copy when an older clipboard write fails late', async () => {
  let reject!: (error: Error) => void
  vi.spyOn(navigator.clipboard, 'writeText').mockReturnValue(
    new Promise<void>((_, fail) => {
      reject = fail
    }),
  )
  const older = vi.fn()
  writeCanvasClipboard(older)
  expect(older).not.toHaveBeenCalled()
  const newer = new DataTransfer()
  const copyNewer = vi.fn()
  writeCanvasClipboard(copyNewer, newer)
  reject(new Error('NotAllowedError'))
  await vi.waitFor(() => expect(useStore.getState().notice).not.toBeNull())
  expect(isCanvasClipboard(newer)).toBe(true)
  expect(copyNewer).toHaveBeenCalledOnce()
  expect(older).not.toHaveBeenCalled()
})
