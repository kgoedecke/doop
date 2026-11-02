import type { ElementInfo } from './frameBridge'

type FlexInfo = Pick<ElementInfo, 'flexDirection' | 'flexWrap' | 'writingMode' | 'direction'>

/** Map the physical alignment picker to CSS's main/cross axes. Reverse,
 * RTL and vertical writing change which physical edge is flex-start. */
export function flexAxes(info: FlexInfo) {
  const vertical = /^(vertical|sideways)-/.test(info.writingMode)
  const inlineForward = (info.direction !== 'rtl') !== (info.writingMode === 'sideways-lr')
  const blockForward = !vertical || info.writingMode.endsWith('-lr')
  const column = info.flexDirection.startsWith('column')
  return {
    main: (column !== vertical ? 'y' : 'x') as 'x' | 'y',
    mainForward: (column ? blockForward : inlineForward) !== info.flexDirection.endsWith('-reverse'),
    crossForward: (column ? inlineForward : blockForward) !== (info.flexWrap === 'wrap-reverse'),
    // CSS gap follows logical rows/columns even in vertical writing.
    gap: column ? 'row-gap' : 'column-gap',
    crossGap: column ? 'column-gap' : 'row-gap',
  }
}

export function flexAlignmentAt(info: FlexInfo, x: number, y: number) {
  const axes = flexAxes(info)
  const main = axes.main === 'x' ? x : y
  const cross = axes.main === 'x' ? y : x
  const values = ['flex-start', 'center', 'flex-end']
  return {
    justify: values[axes.mainForward ? main : 2 - main]!,
    align: values[axes.crossForward ? cross : 2 - cross]!,
  }
}

/** The physical dimension controlled by a flex item's grow/shrink/basis. */
export function flexSizeAxis(
  info: Pick<ElementInfo, 'position' | 'parent' | 'layoutParent'>,
): 'width' | 'height' | null {
  const parent = info.layoutParent ?? info.parent
  if (info.position === 'absolute' || info.position === 'fixed' || !parent?.display.includes('flex')) return null
  const verticalWriting = /^(vertical|sideways)-/.test(parent.writingMode)
  return parent.flexDirection.startsWith('column') !== verticalWriting ? 'height' : 'width'
}
