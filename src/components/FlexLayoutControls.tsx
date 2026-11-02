import { useId, useState } from 'react'
import type { ElementInfo, StylePatch } from '../lib/frameBridge'
import { flexAlignmentAt, flexAxes } from '../lib/flexLayout'
import { cn } from '../lib/utils'
import { useT, type PlainMessageKey } from '../lib/i18n'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Pressable } from './ui/pressable'
import {
  ArrowDownIcon,
  ArrowRightIcon,
  FlipHorizontal2Icon,
  HorizontalPaddingIcon,
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

export function PaddingControls({ info, apply }: { info: ElementInfo; apply: (styles: StylePatch) => void }) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const [top, right, bottom, left] = info.padding
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
              value={info.padding[index] ?? null}
              unit="px"
              onCommit={(value) => apply({ [`padding-${side}`]: `${Math.max(0, value)}px` })}
            />
          ))
        ) : (
          <>
            <NumberField
              label={t('inspector.verticalPadding')}
              prefix={<VerticalPaddingIcon size="rail" />}
              value={top === bottom ? top : null}
              placeholder={t('inspector.mixed')}
              unit="px"
              onCommit={(value) =>
                apply({ 'padding-top': `${Math.max(0, value)}px`, 'padding-bottom': `${Math.max(0, value)}px` })
              }
            />
            <NumberField
              label={t('inspector.horizontalPadding')}
              prefix={<HorizontalPaddingIcon size="rail" />}
              value={left === right ? left : null}
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

export function FlexLayoutControls({ info, apply }: { info: ElementInfo; apply: (styles: StylePatch) => void }) {
  const t = useT()
  const spacingName = useId()
  const axes = flexAxes(info)
  const column = info.flexDirection.startsWith('column')
  const reverse = info.flexDirection.endsWith('-reverse')
  const wrapping = info.flexWrap !== 'nowrap'
  const distributed = info.justifyContent.startsWith('space-')
  const mode = distributed ? info.justifyContent : 'fixed'
  const gap = column ? info.rowGap : info.columnGap
  const crossGap = column ? info.columnGap : info.rowGap
  const align = info.alignItems === 'normal' ? 'stretch' : info.alignItems
  const justify = info.justifyContent === 'normal' ? 'flex-start' : info.justifyContent
  const crossOptions = crossAlignments.map(({ value, label }) => ({ value, label: t(label) }))
  const keptKey = spacing.find(([value]) => value === info.justifyContent)?.[1]
  const keptSpacing = keptKey ? t(keptKey).toLowerCase() : info.justifyContent.replace('space-', 'space ')

  return (
    <PropertySection
      title={t('inspector.flexLayout')}
      action={
        <Button
          variant="bare"
          size="icon-sm"
          className={cn('size-6 rounded-row text-ink-faint', wrapping && 'bg-paper-deep text-ink')}
          aria-label={t('inspector.wrapChildren')}
          title={info.flexWrap === 'wrap-reverse' ? t('inspector.wrapReverse') : t('inspector.wrapChildren')}
          aria-pressed={wrapping}
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
          value={column ? 'column' : 'row'}
          onValueChange={(value) => apply({ 'flex-direction': `${value}${reverse ? '-reverse' : ''}` })}
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
          aria-pressed={reverse}
          onClick={() => apply({ 'flex-direction': `${column ? 'column' : 'row'}${reverse ? '' : '-reverse'}` })}
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
                const target = flexAlignmentAt(info, x, y)
                const active = align === target.align && (distributed || justify === target.justify)
                const label = t('inspector.alignChildren', {
                  vertical: t(VERTICAL[y]!),
                  horizontal: t(HORIZONTAL[x]!),
                })
                return (
                  <Pressable
                    key={`${x}-${y}`}
                    type="button"
                    aria-label={label}
                    aria-pressed={active}
                    title={distributed ? t('inspector.alignKeep', { label, spacing: keptSpacing }) : label}
                    className="group grid place-items-center rounded-tag hover:bg-paper-deep focus-visible:outline-2 focus-visible:outline-ink"
                    onClick={() =>
                      apply({ 'align-items': target.align, ...(!distributed && { 'justify-content': target.justify }) })
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
              options={
                crossAlignments.some(({ value }) => value === align)
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
                    value={gap ?? 0}
                    unit="px"
                    onCommit={(value) => apply({ [axes.gap]: `${Math.max(0, value)}px` })}
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
            value={crossGap ?? 0}
            unit="px"
            onCommit={(value) => apply({ [axes.crossGap]: `${Math.max(0, value)}px` })}
          />
        </PropertyRow>
      )}
      <PaddingControls info={info} apply={apply} />
    </PropertySection>
  )
}
