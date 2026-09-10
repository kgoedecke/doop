import type { LayerKind } from '../lib/layers'
import { BoxIcon, ImageIcon, TextIcon, VectorIcon } from './ui/icons'

/** The glyph a layer row and the element panel show for what an element is. */
export function LayerKindIcon({ kind }: { kind: LayerKind }) {
  const size = { width: 13, height: 13 }
  if (kind === 'text') return <TextIcon {...size} />
  if (kind === 'image') return <ImageIcon {...size} />
  if (kind === 'svg') return <VectorIcon {...size} />
  return <BoxIcon {...size} />
}
