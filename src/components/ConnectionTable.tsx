import type { ReactNode } from 'react'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Badge } from './ui/badge'
import { IconButton } from './ui/icon-button'
import { MenuButton } from './ui/menu-button'
import { Switch } from './ui/switch'
import { StepSlider } from './ui/step-slider'
import { CheckIcon, MoreHorizontalIcon } from './ui/icons'
import {
  DropdownMenu,
  DropdownMenuCaption,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

/**
 * Settings → Doop Agent as two grouped lists. "Connected" holds a row per
 * connection: its tile, the name with a Default (or Off) badge, a
 * short line, and on the right the model dropdown (models, then the effort
 * as tabs), the on/off switch and a "…" menu (Make default, the provider's
 * own extras, Disconnect). "Add a connection" lists the rest, each with
 * Connect; the one being connected shows its key field or sign-in under it.
 * Shared by the model account rows (ModelAccount.tsx) and the Claude Plan
 * (LocalClaude.tsx).
 */

/** Where a connection stands: never connected, connected and in use, or
 *  connected but switched off (its credential kept). */
export type ConnectionState = 'none' | 'on' | 'off'

/** One of the two lists, under its heading. */
export function ConnectionSection({
  title,
  className,
  children,
}: {
  title: string
  className?: string
  children: ReactNode
}) {
  return (
    <section aria-label={title} className={cn('max-w-[1000px]', className)}>
      <h3 className="mb-[10px] ml-1 text-copy font-medium">{title}</h3>
      <div role="list" className="overflow-hidden rounded-panel bg-surface shadow-ring">
        {children}
      </div>
    </section>
  )
}

/* tile · name and line · controls, then whatever opens under the row */
const rowClass = 'border-b border-line-soft last:border-b-0'
const rowLine = 'flex items-center gap-[14px] px-4 py-3 max-md:flex-wrap max-md:gap-y-2'

function RowName({ name, sub, badges }: { name: string; sub?: ReactNode; badges?: ReactNode }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span className="truncate text-copy font-medium">{name}</span>
        {badges}
      </div>
      {sub && <div className="truncate text-label text-ink-faint">{sub}</div>}
    </div>
  )
}

/** What opens under a row, indented to its name. */
function RowPanel({ children }: { children: ReactNode }) {
  return <div className="pb-[14px] pl-[66px] pr-4 text-label text-ink-soft max-md:pl-4">{children}</div>
}

/** A connected provider. */
export function ConnectionRow({
  mark,
  name,
  sub,
  state,
  isDefault,
  busy,
  model,
  onToggle,
  onMakeDefault,
  onDisconnect,
  menuItems = [],
  panel,
  error,
}: {
  mark: ReactNode
  name: string
  sub?: ReactNode
  /** in use, or switched off with its credential kept */
  state: Exclude<ConnectionState, 'none'>
  isDefault: boolean
  busy: boolean
  /** the model dropdown */
  model: ReactNode
  onToggle: (on: boolean) => void
  onMakeDefault?: () => void
  onDisconnect: () => void
  /** the provider's own actions, between Make default and Disconnect */
  menuItems?: { label: string; onSelect: () => void }[]
  /** what opens under the row: a key to replace, a task under way */
  panel?: ReactNode
  /** why the last change to this connection failed, shown under it */
  error?: string | undefined
}) {
  const t = useT()
  const off = state === 'off'
  return (
    <div role="listitem" className={rowClass}>
      <div className={rowLine}>
        <span aria-hidden className={cn('flex-none', off && 'opacity-55')}>
          {mark}
        </span>
        <RowName
          name={name}
          sub={sub}
          badges={
            <>
              {isDefault && <Badge tone="brand">{t('models.isDefault')}</Badge>}
              {off && <Badge>{t('models.off')}</Badge>}
            </>
          }
        />
        <div className="w-[220px] flex-none max-md:order-last max-md:w-full">{model}</div>
        <Switch
          size="sm"
          aria-label={t('models.useConnection', { name })}
          checked={!off}
          disabled={busy}
          onCheckedChange={onToggle}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton aria-label={t('models.moreActions', { name })} disabled={busy}>
              <MoreHorizontalIcon size="rail" aria-hidden />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" width="lg">
            {/* on the default it is done: greyed, with a check where a choice shows its pick */}
            <DropdownMenuItem disabled={isDefault || off || !onMakeDefault} onSelect={() => onMakeDefault?.()}>
              <span className="flex w-full items-center justify-between gap-3">
                {t('models.makeDefault')}
                {isDefault && <CheckIcon size={14} className="text-ink" aria-label={t('models.isDefault')} />}
              </span>
            </DropdownMenuItem>
            {menuItems.map((item) => (
              <DropdownMenuItem key={item.label} onSelect={item.onSelect}>
                {item.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-accent-ink data-[highlighted]:text-accent-ink" onSelect={onDisconnect}>
              {t('models.disconnect')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {(panel || error) && (
        <RowPanel>
          {panel}
          <FieldError className={panel ? undefined : 'mt-0'}>{error}</FieldError>
        </RowPanel>
      )}
    </div>
  )
}

/** Why a field or a connection's last change failed, directly under it;
 *  nothing at all while there is no message. */
export function FieldError({ id, className, children }: { id?: string; className?: string; children?: string }) {
  if (!children) return null
  return (
    <p id={id} role="alert" className={cn('mt-1.5 text-label text-accent-ink', className)}>
      {children}
    </p>
  )
}

/** A provider not connected yet: its tile, name, a short line and Connect.
 *  While it is being connected (`open`) its `panel` shows under it. */
export function AvailableRow({
  mark,
  name,
  sub,
  action,
  panel,
  open = false,
}: {
  mark: ReactNode
  name: string
  sub?: ReactNode
  action?: ReactNode
  panel?: ReactNode
  open?: boolean
}) {
  return (
    <div role="listitem" className={cn(rowClass, open && panel && 'bg-sub')}>
      <div className={rowLine}>
        <span aria-hidden className="flex-none">
          {mark}
        </span>
        <RowName name={name} sub={sub} />
        {action && <div className="flex-none">{action}</div>}
      </div>
      {panel && open && <RowPanel>{panel}</RowPanel>}
    </div>
  )
}

/** A model a row can run, as its dropdown lists it. */
export interface ModelChoice {
  id: string
  name: string
  blurb?: string
  /** false: the model cannot see screenshots, so designs go unreviewed */
  vision?: boolean
}

/**
 * The model dropdown in a connected row: the models, then (where the
 * provider has the dial) the effort. Closed, it reads the model and, in a
 * lighter tone, the effort.
 */
export function ModelSelect({
  name,
  models,
  model,
  onModel,
  efforts,
  effort,
  onEffort,
  disabled,
}: {
  /** the provider, for the trigger's label */
  name: string
  models: ModelChoice[]
  model: string | undefined
  onModel: (id: string) => void
  efforts?: { id: string; name: string; blurb?: string }[]
  effort?: string
  onEffort?: (id: string) => void | Promise<unknown>
  disabled?: boolean
}) {
  const t = useT()
  const current = models.find((m) => m.id === model)
  const label = current?.name ?? model ?? t('models.pickModel')
  /* the CLI's own setting is no pick, so the closed dropdown names none */
  const effortName = effort === 'default' ? undefined : efforts?.find((e) => e.id === effort)?.name
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <MenuButton
          disabled={disabled}
          aria-label={t('models.modelFor', { name })}
          className="w-full min-w-0 justify-start text-ink [&>svg:last-child]:ml-auto"
        >
          <span className="truncate font-medium">{label}</span>
          {effortName && <span className="flex-none text-ink-faint">{effortName}</span>}
          {current?.vision === false && <NoVisionBadge />}
        </MenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" width="auto">
        <DropdownMenuCaption>{t('models.model')}</DropdownMenuCaption>
        <DropdownMenuRadioGroup value={model ?? ''} onValueChange={onModel}>
          {models.map((m) => (
            <DropdownMenuRadioItem key={m.id} value={m.id} title={m.blurb}>
              <span className="flex items-center gap-2">
                {m.name}
                {m.vision === false && <NoVisionBadge />}
              </span>
            </DropdownMenuRadioItem>
          ))}
          {/* a pinned id or server override outside the menu still has to show */}
          {model && !current && <DropdownMenuRadioItem value={model}>{model}</DropdownMenuRadioItem>}
        </DropdownMenuRadioGroup>
        {efforts && efforts.length > 0 && onEffort && (
          <>
            <DropdownMenuSeparator />
            <EffortSlider efforts={efforts} effort={effort} onEffort={onEffort} />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The effort at the foot of a model dropdown, as tabs rather than a list:
 *  one row, the picked one raised. A long name gets its short form; the
 *  blurb rides on the tab's title. */
/** The effort at the foot of a model dropdown: a stepped slider, the level
 *  named above it; each level's blurb rides on its name's title. */
export function EffortSlider({
  efforts,
  effort,
  onEffort,
}: {
  efforts: { id: string; name: string; blurb?: string }[]
  effort: string | undefined
  onEffort: (id: string) => void | Promise<unknown>
}) {
  const t = useT()
  return (
    <div className="px-2.5 pb-2.5 pt-1">
      <DropdownMenuCaption className="px-0">{t('models.reasoningEffort')}</DropdownMenuCaption>
      <StepSlider
        label={t('models.reasoningEffort')}
        steps={efforts.map((e) => ({ id: e.id, name: e.name, ...(e.blurb ? { title: e.blurb } : {}) }))}
        value={effort}
        onValueChange={onEffort}
      />
    </div>
  )
}

export function NoVisionBadge() {
  const t = useT()
  return <Badge className="flex-none">{t('models.noVisualReview')}</Badge>
}
