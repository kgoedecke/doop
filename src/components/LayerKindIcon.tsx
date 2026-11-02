import type { LayerKind } from '../lib/layers'
import { BoxIcon, ComponentIcon, ImageIcon, TextIcon, VectorIcon } from './ui/icons'

/** The glyph a layer row and the element panel show for what an element is. */
export function LayerKindIcon({ kind }: { kind: LayerKind }) {
  const size = { width: 14, height: 14 }
  if (kind === 'text') return <TextIcon {...size} />
  if (kind === 'image') return <ImageIcon {...size} />
  if (kind === 'svg') return <VectorIcon {...size} />
  if (kind === 'component') return <ComponentIcon {...size} />
  return <BoxIcon {...size} />
}
