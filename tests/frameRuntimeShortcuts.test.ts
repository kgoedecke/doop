import { runInContext } from 'node:vm'
import { MessageChannel, MessagePort, receiveMessageOnPort } from 'node:worker_threads'
import { Window } from 'happy-dom'
import { expect, it } from 'vitest'
import { FRAME_BOOTSTRAP } from '../src/lib/frameRuntime'

it.each([
  { code: 'Digit1', key: '&', desktopShell: false, prevented: false, relayed: true },
  { code: 'Comma', key: ',', desktopShell: false, prevented: false, relayed: true },
  { code: 'KeyW', key: 'ц', desktopShell: false, prevented: false, relayed: false },
  { code: 'Digit1', key: '&', desktopShell: true, prevented: true, relayed: true },
  { code: 'Comma', key: ',', desktopShell: true, prevented: true, relayed: true },
  { code: 'KeyW', key: 'ц', desktopShell: true, prevented: true, relayed: true },
])('handles $code during frame text editing (desktopShell=$desktopShell)', async (test) => {
  const host = new Window()
  const { port1, port2 } = new MessageChannel()
  try {
    const iframe = host.document.createElement('iframe')
    host.document.body.append(iframe)
    const frame = iframe.contentWindow
    if (!frame || !('KeyboardEvent' in frame)) throw new Error('Expected a same-origin iframe')
    const doc = iframe.contentDocument!
    doc.body.innerHTML = '<p>Text being edited</p>'

    // Happy DOM uses own fields; the runtime captures the browser prototype getters at boot.
    class FrameKeyboardEvent extends frame.KeyboardEvent {}
    class FrameMessageEvent extends frame.MessageEvent {}
    function exposeGetters(prototype: object, fields: string[]) {
      for (const field of fields) {
        Object.defineProperty(prototype, field, {
          get(this: object): unknown {
            return Object.getOwnPropertyDescriptor(this, field)?.value
          },
        })
      }
    }
    exposeGetters(FrameKeyboardEvent.prototype, ['key', 'code', 'ctrlKey', 'metaKey', 'shiftKey', 'altKey', 'repeat'])
    exposeGetters(FrameMessageEvent.prototype, ['source', 'data'])
    Object.assign(frame, { KeyboardEvent: FrameKeyboardEvent, MessageEvent: FrameMessageEvent, MessagePort })
    // The bootstrap also listens for font loads, which Happy DOM does not implement.
    Object.defineProperty(doc, 'fonts', { value: new frame.EventTarget() })

    const bootstrap = new frame.DOMParser().parseFromString(FRAME_BOOTSTRAP, 'text/html')
    runInContext(bootstrap.querySelector('script[data-v-boot]')!.textContent!, frame)

    // Supply browser-trusted events only in this test, including the parent's port handoff.
    const send = (data: object, port?: MessagePort) => {
      const message = new FrameMessageEvent('message', { source: host, data })
      Object.defineProperties(message, { isTrusted: { value: true }, ports: { value: port ? [port] : [] } })
      frame.dispatchEvent(message)
    }
    send({ type: 'doop:runtime-port', desktopShell: test.desktopShell }, port2)
    send({ type: 'doop:edit', on: true })

    const keydown = new FrameKeyboardEvent('keydown', {
      key: test.key,
      code: test.code,
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    Object.defineProperty(keydown, 'isTrusted', { value: true })
    doc.querySelector('p')!.dispatchEvent(keydown)

    const relay: unknown = receiveMessageOnPort(port1)?.message
    if (test.relayed) expect(relay).toMatchObject({ event: 'keydown', code: test.code })
    else expect(relay).toBeUndefined()
    expect(keydown.defaultPrevented).toBe(test.prevented)
  } finally {
    port1.close()
    port2.close()
    await host.happyDOM.close()
  }
})
