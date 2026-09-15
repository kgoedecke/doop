import recorderUrl from 'posthog-js/dist/recorder.js?url'
import type record from 'posthog-js/dist/recorder'
import type { serializedNodeWithId } from 'posthog-js/dist/rrweb-types'

type Recorder = typeof record
type Options = NonNullable<Parameters<Recorder>[0]>

/** Replay must rebuild the recorded DOM, not navigate back to our empty
 * bootstrap. These attributes are changed only in snapshots; the live iframe
 * retains its opaque-origin sandbox. The replay sandbox still blocks scripts. */
function prepareFrameNode(node: serializedNodeWithId) {
  if ('attributes' in node && node.tagName === 'iframe' && 'data-doop-frame' in node.attributes) {
    delete node.attributes.srcdoc
    node.attributes.sandbox = 'allow-same-origin'
  }
  if ('childNodes' in node) node.childNodes.forEach(prepareFrameNode)
}

/** PostHog exposes no recorder lifecycle subscription. Adapt its bundled rrweb
 * entrypoint before init, preserving its static methods. This also observes the
 * effective masking options (including remote privacy settings), and checkout
 * snapshots. Keep the real-browser regression test when upgrading posthog-js. */
export function installFrameReplay(
  rrweb = (window as Window & { __PosthogExtensions__?: { rrweb?: { record: Recorder } } }).__PosthogExtensions__
    ?.rrweb,
) {
  if (!rrweb) return
  const original = rrweb.record
  let options: Options | null = null
  let generation = 0
  const frames = () => document.querySelectorAll<HTMLIFrameElement>('iframe[data-doop-frame]')
  function send(frame: HTMLIFrameElement, snapshot = false) {
    frame.contentWindow?.postMessage(
      { type: 'doop:replay', options, generation, snapshot, url: new URL(recorderUrl, location.href).href },
      '*', // sandboxed srcdoc has an opaque origin
    )
  }
  function broadcast(snapshot = false) {
    frames().forEach((frame) => send(frame, snapshot))
  }
  window.addEventListener('message', (event) => {
    if (event.data?.type !== 'doop:frame-ready') return
    const frame = Array.from(frames()).find((frame) => frame.contentWindow === event.source)
    if (frame) send(frame)
  })

  rrweb.record = Object.assign((config: Options = {}) => {
    generation++
    const current = generation
    // Copy only serializable capture/privacy options, never callbacks/plugins.
    const child: Options = {}
    const keys = [
      'blockClass',
      'blockSelector',
      'ignoreClass',
      'ignoreSelector',
      'maskTextClass',
      'maskTextSelector',
      'maskAllInputs',
      'maskInputOptions',
      'maskAllElementAttributes',
      'slimDOMOptions',
      'inlineStylesheet',
      'inlineStylesheetBudgetRules',
      'collectFonts',
      'sampling',
      'attributeFilter',
    ] as const
    for (const key of keys) {
      if (config[key] !== undefined) Object.assign(child, { [key]: config[key] })
    }
    // Custom masking functions cannot cross postMessage. Fail closed if added.
    options = config.maskInputFn || config.maskTextFn || config.maskAttributeFn ? null : child
    let stop: ReturnType<Recorder>
    try {
      stop = original({
        ...config,
        emit(event, checkout) {
          if (event.type === 2) prepareFrameNode(event.data.node)
          if (event.type === 3 && event.data.source === 0) {
            event.data.adds.forEach(({ node }) => prepareFrameNode(node))
            for (const mutation of event.data.attributes) {
              const element = original.mirror.getNode(mutation.id)
              if (element instanceof HTMLIFrameElement && element.hasAttribute('data-doop-frame')) {
                delete mutation.attributes.srcdoc
                if ('sandbox' in mutation.attributes) mutation.attributes.sandbox = 'allow-same-origin'
              }
            }
          }
          config.emit?.(event, checkout)
          if (event.type === 2) {
            // Run after rrweb has registered every iframe in its node mirror.
            queueMicrotask(() => {
              if (generation === current) broadcast(true)
            })
          }
        },
      })
    } catch (error) {
      options = null
      broadcast()
      throw error
    }
    if (!stop) options = null
    broadcast()
    if (!stop) return undefined
    return () => {
      stop?.()
      if (generation === current) {
        options = null
        broadcast()
      }
    }
  }, original) as Recorder
}
