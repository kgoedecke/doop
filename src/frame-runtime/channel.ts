/* The runtime's trusted line to the editor. Keys and saves travel over a
   MessagePort the parent hands this runtime once, so a design's own script,
   which shares the window, has nothing to post a forged key or save
   through: not the port (it lives in this module), not postMessage (the
   parent takes keys from the port alone), and no synthetic event (only
   trusted ones are relayed). Everything the channel touches is pinned when
   this module is evaluated, before any design script runs: the port's send,
   Reflect.apply (so no patched Function.prototype.call ever sees the port)
   and the events' own getters (so a patched prototype cannot turn the key
   the person pressed into another, or a forged message into the editor's). */

type Getter = (this: unknown) => unknown

export function getter(proto: object, name: string): Getter | undefined {
  const d = Object.getOwnPropertyDescriptor(proto, name)
  return d && (d.get as Getter | undefined)
}

export const hasOwn = Object.hasOwn
export const editorWindow = parent
export const apply = Reflect.apply
const portSend = MessagePort.prototype.postMessage as (this: MessagePort, message: unknown) => void
export const readMessageSource = getter(MessageEvent.prototype, 'source')!
export const readMessageData = getter(MessageEvent.prototype, 'data')!
export const readType = getter(Event.prototype, 'type')!
export const readTarget = getter(Event.prototype, 'target')!
/* isTrusted is the event's own, unforgeable property; it is read through
   the prototype getter only where an engine puts it there */
const readTrusted = getter(Event.prototype, 'isTrusted')
export const readNodeType = getter(Node.prototype, 'nodeType')!
export const readEditable = getter(HTMLElement.prototype, 'isContentEditable')!
export const elementMatches = Element.prototype.matches

/** the key fields the relay reads, each through its pinned getter */
export const KEY_FIELDS = ['key', 'code', 'ctrlKey', 'metaKey', 'shiftKey', 'altKey', 'repeat'] as const
export type KeyField = (typeof KEY_FIELDS)[number]
export const keyGetters = {} as Record<KeyField, Getter>
for (const field of KEY_FIELDS) keyGetters[field] = getter(KeyboardEvent.prototype, field)!

/** the port the editor handed over, for life */
export let runtimePort: MessagePort | null = null

/* the first port offered is the one for life: a later message carrying
   one could be answering a design script's forged ready signal */
export function adoptRuntimePort(port: MessagePort): void {
  if (!runtimePort) runtimePort = port
}

/** a message down the port; callers check runtimePort first */
export function sendToEditor(message: unknown): void {
  apply(portSend, runtimePort, [message])
}

export function isTrusted(ev: Event): boolean {
  return !!(readTrusted ? apply(readTrusted, ev, []) : ev.isTrusted)
}
