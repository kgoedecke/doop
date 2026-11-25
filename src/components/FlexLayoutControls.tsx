import { useId, useState } from 'react'
import type { ElementInfo, StylePatch } from '../lib/frameBridge'
import { commonValue } from '../lib/cssValues'
import { flexAlignmentAt, flexAxes } from '../lib/flexLayout'
import { cn } from '../lib/utils'
import { useT, type PlainMessageKey } from '../lib/i18n'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Pressable } from './ui/pressable'
import {
  ArrowDownIcon,
  ArrowRightIcon,
  ColumnGapIcon,
  FlipHorizontal2Icon,
  HorizontalPaddingIcon,
  RowGapIcon,
  SquareDashedIcon,
  VerticalPaddingIcon,
  WrapTextIcon,
} from './ui/icons'
import { NumberField, PropertyRow, PropertySection, SelectField } from './ui/property-field'
import { Segmented, SegmentedItem } from './ui/segmented'

const control = 'h-[26px] min-h-0 rounded-row bg-sub p-0 text-ink-soft'
const caption = 'mb-1 text-caption text-ink-faint'
const spacing = [
  ['fixed', 'inspector.spacingFixed'],
  ['space-between', 'inspector.spacingBetween'],
  ['space-around', 'inspector.spacingAround'],
  ['space-evenly', 'inspector.spacingEvenly'],
] as const satisfies readonly (readonly [string, PlainMessageKey])[]
const crossAlignments: { value: string; label: PlainMessageKey }[] = [
  { value: 'flex-start', label: 'inspector.crossStart' },
  { value: 'center', label: 'inspector.crossCenter' },
  { value: 'flex-end', label: 'inspector.crossEnd' },
  { value: 'stretch', label: 'inspector.crossStretch' },
  { value: 'baseline', label: 'inspector.crossBaseline' },
]
const PADDING_SIDES = [
  ['top', 'inspector.paddingTop'],
  ['right', 'inspector.paddingRight'],
  ['bottom', 'inspector.paddingBottom'],
  ['left', 'inspector.paddingLeft'],
] as const satisfies readonly (readonly [string, PlainMessageKey])[]
const VERTICAL: PlainMessageKey[] = ['inspector.vTop', 'inspector.vMiddle', 'inspector.vBottom']
const HORIZONTAL: PlainMessageKey[] = ['inspector.hLeft', 'inspector.hCenter', 'inspector.hRight']

export function PaddingControls({
  selection,
  apply,
}: {
  selection: ElementInfo[]
  apply: (styles: StylePatch) => void
}) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const [top, right, bottom, left] = [0, 1, 2, 3].map((index) =>
    commonValue(selection, (el) => el.padding[index] ?? null),
  )
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-caption text-ink-faint">{t('inspector.padding')}</span>
        <Button
          variant="bare"
          size="icon-sm"
          className="size-5 rounded-tag text-ink-faint"
          aria-label={t('inspector.individualPadding')}
          title={t('inspector.individualPaddingTitle')}
          aria-expanded={expanded}
          aria-pressed={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <SquareDashedIcon size="rail" />
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {expanded ? (
          PADDING_SIDES.map(([side, label], index) => (
            <NumberField
              key={side}
              label={t(label)}
              prefix={side[0]!.toUpperCase()}
              value={commonValue(selection, (el) => el.padding[index] ?? null)}
              placeholder={t('inspector.mixed')}
              unit="px"
              onCommit={(value) => apply({ [`padding-${side}`]: `${Math.max(0, value)}px` })}
            />
          ))
        ) : (
          <>
            <NumberField
              label={t('inspector.verticalPadding')}
              prefix={<VerticalPaddingIcon size="rail" />}
              value={top === bottom ? (top ?? null) : null}
              placeholder={t('inspector.mixed')}
              unit="px"
              onCommit={(value) =>
                apply({ 'padding-top': `${Math.max(0, value)}px`, 'padding-bottom': `${Math.max(0, value)}px` })
              }
            />
            <NumberField
              label={t('inspector.horizontalPadding')}
              prefix={<HorizontalPaddingIcon size="rail" />}
              value={left === right ? (left ?? null) : null}
              placeholder={t('inspector.mixed')}
              unit="px"
              onCommit={(value) =>
                apply({ 'padding-left': `${Math.max(0, value)}px`, 'padding-right': `${Math.max(0, value)}px` })
              }
            />
          </>
        )}
      </div>
    </div>
  )
}

export function FlexLayoutControls({
  selection,
  apply,
}: {
  selection: ElementInfo[]
  apply: (styles: StylePatch | ((el: ElementInfo) => StylePatch)) => void
}) {
  const t = useT()
  const spacingName = useId()
  const common = <V,>(read: (el: ElementInfo) => V) => commonValue(selection, read)
  const column = common((el) => el.flexDirection.startsWith('column'))
  const reverse = common((el) => el.flexDirection.endsWith('-reverse'))
  const wrapping = common((el) => el.flexWrap !== 'nowrap')
  const distributed = common((el) => el.justifyContent.startsWith('space-'))
  const mode = common((el) => (el.justifyContent.startsWith('space-') ? el.justifyContent : 'fixed'))
  const gap = common((el) => (el.flexDirection.startsWith('column') ? el.rowGap : el.columnGap) ?? 0)
  const crossGap = common((el) => (el.flexDirection.startsWith('column') ? el.columnGap : el.rowGap) ?? 0)
  const align = common((el) => (el.alignItems === 'normal' ? 'stretch' : el.alignItems))
  const crossOptions = crossAlignments.map(({ value, label }) => ({ value, label: t(label) }))
  const keptKey = spacing.find(([value]) => value === mode)?.[1]
  const keptSpacing = keptKey ? t(keptKey).toLowerCase() : (mode?.replace('space-', 'space ') ?? '')

  return (
    <PropertySection
      title={t('inspector.flexLayout')}
      action={
        <Button
          variant="bare"
          size="icon-sm"
          className={cn('size-6 rounded-row text-ink-faint', wrapping && 'bg-paper-deep text-ink')}
          aria-label={t('inspector.wrapChildren')}
          title={
            common((el) => el.flexWrap) === 'wrap-reverse' ? t('inspector.wrapReverse') : t('inspector.wrapChildren')
          }
          aria-pressed={wrapping ?? 'mixed'}
          onClick={() => apply({ 'flex-wrap': wrapping ? 'nowrap' : 'wrap' })}
        >
          <WrapTextIcon size="rail" />
        </Button>
      }
    >
      <div className="flex gap-1.5">
        <Segmented
          className="min-w-0 flex-1 rounded-row bg-sub p-0.5"
          aria-label={t('inspector.flexDirection')}
          value={column === null ? '' : column ? 'column' : 'row'}
          onValueChange={(value) =>
            apply((el) => ({ 'flex-direction': `${value}${el.flexDirection.endsWith('-reverse') ? '-reverse' : ''}` }))
          }
        >
          {[
            { value: 'row', label: t('inspector.rowDirection'), Icon: ArrowRightIcon },
            { value: 'column', label: t('inspector.columnDirection'), Icon: ArrowDownIcon },
          ].map(({ value, label, Icon }) => (
            <SegmentedItem
              key={value}
              value={value}
              aria-label={label}
              title={label}
              className="grid h-[22px] min-h-0 flex-1 place-items-center rounded-tag p-0 sm:flex-1"
            >
              <Icon size="rail" />
            </SegmentedItem>
          ))}
        </Segmented>
        <Button
          variant="bare"
          size="icon-sm"
          className={cn(control, 'w-[30px]', reverse && 'bg-paper-deep text-ink')}
          aria-label={t('inspector.reverseDirection')}
          title={t('inspector.reverseDirection')}
          aria-pressed={reverse ?? 'mixed'}
          onClick={() =>
            apply((el) => ({
              'flex-direction': `${el.flexDirection.startsWith('column') ? 'column' : 'row'}${reverse ? '' : '-reverse'}`,
            }))
          }
        >
          <FlipHorizontal2Icon size="rail" />
        </Button>
      </div>
      <div className="mt-2 grid grid-cols-[84px_minmax(0,1fr)] gap-2">
        <div>
          <div className={caption}>{t('inspector.alignment')}</div>
          <div
            role="group"
            aria-label={t('inspector.flexAlignment')}
            className="grid size-[84px] grid-cols-3 grid-rows-3 rounded-row bg-sub p-1"
          >
            {[0, 1, 2].flatMap((y) =>
              [0, 1, 2].map((x) => {
                const active = common((el) => {
                  const target = flexAlignmentAt(el, x, y)
                  const align = el.alignItems === 'normal' ? 'stretch' : el.alignItems
                  const justify = el.justifyContent === 'normal' ? 'flex-start' : el.justifyContent
                  return align === target.align && (justify.startsWith('space-') || justify === target.justify)
                })
                const label = t('inspector.alignChildren', {
                  vertical: t(VERTICAL[y]!),
                  horizontal: t(HORIZONTAL[x]!),
                })
                return (
                  <Pressable
                    key={`${x}-${y}`}
                    type="button"
                    aria-label={label}
                    aria-pressed={active ?? 'mixed'}
                    title={distributed ? t('inspector.alignKeep', { label, spacing: keptSpacing }) : label}
                    className="group grid place-items-center rounded-tag hover:bg-paper-deep focus-visible:outline-2 focus-visible:outline-ink"
                    onClick={() =>
                      apply((el): StylePatch => {
                        const target = flexAlignmentAt(el, x, y)
                        return {
                          'align-items': target.align,
                          ...(!el.justifyContent.startsWith('space-') && { 'justify-content': target.justify }),
                        }
                      })
                    }
                  >
                    <span
                      className={cn(
                        'size-[3px] rounded-none bg-ink-faint group-hover:size-2',
                        active && 'size-2 rounded-tag bg-brand',
                      )}
                    />
                  </Pressable>
                )
              }),
            )}
          </div>
          <div className="mt-1.5 flex">
            <SelectField
              label={t('inspector.crossAxisAlignment')}
              value={align}
              placeholder={t('inspector.mixed')}
              options={
                !align || crossAlignments.some(({ value }) => value === align)
                  ? crossOptions
                  : [...crossOptions, { value: align, label: align }]
              }
              onChange={(value) => apply({ 'align-items': value })}
            />
          </div>
        </div>
        <div>
          <div className={caption}>{t('inspector.gap')}</div>
          <div role="radiogroup" aria-label={t('inspector.flexSpacing')} className="space-y-1">
            {spacing.map(([value, label]) => (
              <div key={value} className="flex h-[26px] items-center gap-1.5">
                <label className="flex min-w-0 cursor-pointer items-center gap-1.5 text-caption text-ink-soft">
                  <Input
                    variant="bare"
                    inputSize="auto"
                    type="radio"
                    className="size-3 shrink-0 accent-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                    name={spacingName}
                    aria-label={t(label)}
                    checked={mode === value}
                    onChange={() => apply({ 'justify-content': value === 'fixed' ? 'flex-start' : value })}
                  />
                  {value !== 'fixed' && t(label)}
                </label>
                {value === 'fixed' && (
                  <NumberField
                    label={t('inspector.gap')}
                    prefix={column ? <RowGapIcon size="rail" /> : <ColumnGapIcon size="rail" />}
                    value={gap}
                    placeholder={t('inspector.mixed')}
                    unit="px"
                    onCommit={(value) => apply((el) => ({ [flexAxes(el).gap]: `${Math.max(0, value)}px` }))}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      {wrapping && (
        <PropertyRow label={t('inspector.lineGap')}>
          <NumberField
            label={t('inspector.lineGap')}
            prefix={column ? <ColumnGapIcon size="rail" /> : <RowGapIcon size="rail" />}
            value={crossGap}
            placeholder={t('inspector.mixed')}
            unit="px"
            onCommit={(value) => apply((el) => ({ [flexAxes(el).crossGap]: `${Math.max(0, value)}px` }))}
          />
        </PropertyRow>
      )}
      <PaddingControls selection={selection} apply={apply} />
    </PropertySection>
  )
}
