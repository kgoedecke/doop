import type { PlainMessageKey } from '@/lib/i18n'

/** The viewer's own fonts: the one place a design asks for the device's
 *  look on purpose, and so renders differently on each machine. */
export const DEVICE_FONTS: { value: string; label: PlainMessageKey }[] = [
  { value: 'system-ui, sans-serif', label: 'inspector.fontSystemUi' },
  { value: 'ui-monospace, monospace', label: 'inspector.fontSystemMono' },
]
