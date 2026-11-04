import { useState, type ReactNode } from 'react'
import {
  DEFAULT_THEME,
  MAX_TOKEN_THEMES,
  aliasOf,
  effectiveValue,
  TOKEN_GROUPS,
  isThemeName,
  isTokenName,
  normalizeTokenName,
  resolveToken,
  tokenLabel,
  sortTokens,
  type DesignToken,
  type ThemeRename,
  type TokenType,
} from '../../shared/designTokens'
import { canEditOpenCanvas, useStore } from '../lib/store'
import { useCanvasFonts } from '../lib/customFonts'
import { DEVICE_FONTS } from '../lib/deviceFonts'
import { fontStack, libraryFamilies } from '../../shared/fonts'
import { WEB_FONTS, webFontStack } from '../../shared/webFonts'
import { api } from '../lib/api'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Field } from './ui/field'
import { IconButton } from './ui/icon-button'
import { ListHint, ListRow } from './ui/list'
import { Modal, ModalActions, ModalLede, ModalSpacer, ModalTitle } from './ui/modal'
import { sectionHeading } from './PagesPanel'
import { ConfirmDialog } from './ui/alert-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { PlusIcon, XIcon } from './ui/icons'
import { type PlainMessageKey, useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/** The i18n label of each token type, in the add menu's wording. */
export const TOKEN_TYPE_LABEL: Record<TokenType, PlainMessageKey> = {
  color: 'panels.tokensTypeColor',
  opacity: 'panels.tokensTypeOpacity',
  radius: 'panels.tokensTypeRadius',
  spacing: 'panels.tokensTypeSpacing',
  container: 'panels.tokensTypeContainer',
  breakpoint: 'panels.tokensTypeBreakpoint',
  fontFamily: 'panels.tokensTypeFontFamily',
  fontWeight: 'panels.tokensTypeFontWeight',
  fontSize: 'panels.tokensTypeFontSize',
  lineHeight: 'panels.tokensTypeLineHeight',
  letterSpacing: 'panels.tokensTypeLetterSpacing',
}

/** The heading over a type's rows: the plural. */
const TOKEN_GROUP_LABEL: Record<TokenType, PlainMessageKey> = {
  color: 'panels.tokensGroupColor',
  opacity: 'panels.tokensGroupOpacity',
  radius: 'panels.tokensGroupRadius',
  spacing: 'panels.tokensGroupSpacing',
  container: 'panels.tokensGroupContainer',
  breakpoint: 'panels.tokensGroupBreakpoint',
  fontFamily: 'panels.tokensGroupFontFamily',
  fontWeight: 'panels.tokensGroupFontWeight',
  fontSize: 'panels.tokensGroupFontSize',
  lineHeight: 'panels.tokensGroupLineHeight',
  letterSpacing: 'panels.tokensGroupLetterSpacing',
}

function firstMessage(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message.replace(/^\d+\s*/, '') : fallback
}

const sectionBtn = 'size-5 rounded-tag text-ink-faint hover:bg-paper-deep hover:text-ink'

/** A name that reads like a token of each type, as the name field's hint. */
const NAME_HINT: Record<TokenType, string> = {
  color: 'primary',
  opacity: 'muted',
  radius: 'card',
  spacing: 'space-4',
  container: 'content',
  breakpoint: 'md',
  fontFamily: 'body',
  fontWeight: 'medium',
  fontSize: 'copy',
  lineHeight: 'tight',
  letterSpacing: 'caps',
}

/** The Tokens tab: the canvas's design tokens by type, shown under one
 *  theme at a time, with the theme picker and the add button on one line. */
export function TokensSection() {
  const canvasId = useStore((s) => s.canvas?.id)
  const tokens = useStore((s) => s.canvas?.tokens ?? [])
  const themes = useStore((s) => s.canvas?.tokenThemes ?? [])
  const readOnly = useStore((s) => !canEditOpenCanvas(s))
  /** the open token's name, a type to create one of, or null */
  const [open, setOpen] = useState<{ name: string } | { create: TokenType } | null>(null)
  /** which theme's values the rows show; null is the default */
  const [viewTheme, setViewTheme] = useState<string | null>(null)
  const [managing, setManaging] = useState(false)
  const t = useT()
  if (!canvasId) return null

  /* a theme that left takes the view back to the default */
  const shown = viewTheme && themes.includes(viewTheme) ? viewTheme : null
  const sorted = sortTokens(tokens)
  return (
    <>
      {/* Themes, in the Pages section's dress: the heading with its plus, the picker under it */}
      <div className={cn('mt-1.5 flex h-6 flex-none items-center justify-between pr-2.5 pl-3.5', sectionHeading)}>
        <span className={sectionHeading}>{t('panels.tokensThemesTitle')}</span>
        {!readOnly && (
          <Button
            variant="bare"
            size="icon-sm"
            className={sectionBtn}
            aria-label={t('panels.tokensManageThemes')}
            title={t('panels.tokensManageThemes')}
            onClick={() => setManaging(true)}
          >
            <PlusIcon className="size-3.5" />
          </Button>
        )}
      </div>
      <div className="px-2 pb-1" onKeyDown={(e) => e.stopPropagation()}>
        <Select value={shown ?? DEFAULT_THEME} onValueChange={(v) => setViewTheme(v === DEFAULT_THEME ? null : v)}>
          <SelectTrigger size="sm" className="w-full font-mono" aria-label={t('panels.tokensTheme')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_THEME}>{DEFAULT_THEME}</SelectItem>
            {themes.map((theme) => (
              <SelectItem key={theme} value={theme}>
                {theme}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {/* Tokens: the heading with its plus, the rows by type under it */}
      <div className={cn('mt-1.5 flex h-6 flex-none items-center justify-between pr-2.5 pl-3.5', sectionHeading)}>
        <span className={sectionHeading}>{t('panels.tokensTitle')}</span>
        {!readOnly && (
          <Button
            variant="bare"
            size="icon-sm"
            className={sectionBtn}
            aria-label={t('panels.tokensNew')}
            title={t('panels.tokensNew')}
            onClick={() => setOpen({ create: 'color' })}
          >
            <PlusIcon className="size-3.5" />
          </Button>
        )}
      </div>
      {sorted.length === 0 && <ListHint>{t('panels.tokensHint')}</ListHint>}
      {TOKEN_GROUPS.flat().map((type) => {
        const rows = sorted.filter((token) => token.type === type)
        if (!rows.length) return null
        return (
          <div key={type}>
            <div className="px-4 pb-1 pt-2.5 text-caption text-ink-faint">{t(TOKEN_GROUP_LABEL[type])}</div>
            {rows.map((token) => (
              <ListRow
                key={token.name}
                className="flex-row items-center gap-2.5 py-2"
                onClick={() => setOpen({ name: token.name })}
              >
                <TokenSwatch token={token} tokens={tokens} theme={shown ?? undefined} />
                <span className="min-w-0 flex-1 truncate font-mono text-label text-ink">{tokenLabel(token.name)}</span>
                <span
                  className={cn(
                    'max-w-[45%] flex-none truncate font-mono text-caption',
                    shown && token.themes?.[shown] === undefined ? 'text-ink-faint' : 'text-ink-soft',
                  )}
                  title={shown && token.themes?.[shown] === undefined ? t('panels.tokensValueInherits') : undefined}
                >
                  {effectiveValue(token, shown ?? undefined)}
                </span>
              </ListRow>
            ))}
          </div>
        )
      })}
      {open !== null && (
        <TokenModal
          canvasId={canvasId}
          name={'name' in open ? open.name : null}
          createType={'create' in open ? open.create : null}
          onClose={() => setOpen(null)}
        />
      )}
      {managing && <ThemesModal canvasId={canvasId} themes={themes} onClose={() => setManaging(false)} />}
    </>
  )
}

/** A colour's resolved swatch; other types show a quiet type mark. */
export function TokenSwatch({
  token,
  tokens,
  size = 14,
  theme,
}: {
  token: DesignToken
  tokens: readonly DesignToken[]
  size?: number
  /** resolve under this theme; unset is the default */
  theme?: string
}) {
  if (token.type !== 'color')
    return <span className="inline-block flex-none rounded-tag bg-paper-deep" style={{ width: size, height: size }} />
  const resolved = resolveToken(tokens, token.name, theme) ?? effectiveValue(token, theme)
  return (
    <span
      className="inline-block flex-none overflow-hidden rounded-tag shadow-ring"
      style={{ width: size, height: size, background: resolved }}
    />
  )
}

type Draft = { name: string; type: TokenType; value: string; description: string; themes: Record<string, string> }

/** What a new token of a type starts as, so the form never opens empty. */
const DEFAULT_VALUE: Record<TokenType, string> = {
  color: '#111111',
  opacity: '1',
  radius: '8px',
  spacing: '8px',
  container: '1200px',
  breakpoint: '768px',
  fontFamily: 'Inter, sans-serif',
  fontWeight: '400',
  fontSize: '16px',
  lineHeight: '1.5',
  letterSpacing: '0em',
}

function draftOf(token: DesignToken | null, createType: TokenType | null, initialValue = ''): Draft {
  const type = token?.type ?? createType ?? 'color'
  return {
    name: token ? tokenLabel(token.name) : '',
    type,
    value: token?.value ?? (initialValue || DEFAULT_VALUE[type]),
    description: token?.description ?? '',
    themes: { ...(token?.themes ?? {}) },
  }
}

/** One token in a modal: name, type, value, a value per theme, use. name =
 *  null creates one of createType, starting from initialValue (the Design
 *  panel hands over the field's current literal); onCreated gets its name. */
export function TokenModal({
  canvasId,
  name,
  createType,
  initialValue,
  onCreated,
  onClose,
}: {
  canvasId: string
  name: string | null
  createType: TokenType | null
  initialValue?: string
  onCreated?: (name: string) => void
  onClose: () => void
}) {
  const token = useStore((s) => s.canvas?.tokens?.find((d) => d.name === name) ?? null)
  const tokens = useStore((s) => s.canvas?.tokens ?? [])
  const themes = useStore((s) => s.canvas?.tokenThemes ?? [])
  const readOnly = useStore((s) => !canEditOpenCanvas(s))
  const creating = name === null
  const [draft, setDraft] = useState<Draft>(() => draftOf(token, createType, initialValue))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const t = useT()

  const typedName = normalizeTokenName(draft.name)
  const validName = isTokenName(typedName)
  const canSave = validName && draft.value.trim() !== '' && !busy && !readOnly

  async function save() {
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      const modeValues = Object.fromEntries(
        themes.map((theme) => [theme, draft.themes[theme]?.trim() ? draft.themes[theme]!.trim() : null]),
      )
      if (creating) {
        const { results } = await api.createTokens(canvasId, [
          {
            name: typedName,
            type: draft.type,
            value: draft.value.trim(),
            description: draft.description.trim() || undefined,
            themes: Object.fromEntries(Object.entries(modeValues).filter((entry) => entry[1] !== null)) as Record<
              string,
              string
            >,
          },
        ])
        const [result] = results
        if (result?.result === 'error') throw new Error(result.message)
        onCreated?.(typedName)
      } else {
        /* only the fields that changed, so a concurrent edit elsewhere is kept */
        const was = token!
        const changedThemes = Object.fromEntries(
          Object.entries(modeValues).filter(([theme, value]) => (was.themes?.[theme] ?? null) !== value),
        )
        await api.setToken(canvasId, was.name, {
          ...(typedName !== was.name ? { newName: typedName } : {}),
          ...(draft.type !== was.type ? { type: draft.type } : {}),
          ...(draft.value.trim() !== was.value ? { value: draft.value.trim() } : {}),
          ...(draft.description.trim() !== (was.description ?? '') ? { description: draft.description.trim() } : {}),
          ...(Object.keys(changedThemes).length ? { themes: changedThemes } : {}),
        })
      }
      onClose()
    } catch (e) {
      setError(firstMessage(e, t('panels.tokensSaveFailed')))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!token || busy) return
    setBusy(true)
    try {
      await api.deleteToken(canvasId, token.name)
      onClose()
    } catch (e) {
      setError(firstMessage(e, t('panels.tokensSaveFailed')))
      setBusy(false)
    }
  }

  if (!creating && !token)
    return (
      <Modal size="md" onClose={onClose}>
        <ModalTitle className="sr-only">{t('panels.tokensGone')}</ModalTitle>
        <ModalLede>{t('panels.tokensGone')}</ModalLede>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
        </ModalActions>
      </Modal>
    )

  return (
    <Modal size="md" onClose={() => !busy && onClose()}>
      <div className="flex flex-wrap items-baseline gap-2.5">
        <ModalTitle>
          {t(creating ? 'panels.tokensNewTitle' : 'panels.tokensEditTitle', { type: t(TOKEN_TYPE_LABEL[draft.type]) })}
        </ModalTitle>
      </div>
      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div className={cn('grid gap-3', creating && 'sm:grid-cols-[minmax(0,1fr)_160px]')}>
          <Field label={t('panels.tokensName')}>
            <Input
              variant="well"
              className="font-mono"
              autoFocus={creating}
              placeholder={NAME_HINT[draft.type]}
              value={draft.name}
              disabled={busy || readOnly}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Field>
          {creating && (
            <Field label={t('panels.tokensType')}>
              <Select
                value={draft.type}
                onValueChange={(v) => {
                  const type = v as TokenType
                  /* a type change the value cannot carry over starts from the type's default */
                  setDraft({ ...draft, type, value: creating ? DEFAULT_VALUE[type] : draft.value })
                }}
                disabled={busy || readOnly}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TOKEN_GROUPS.flat().map((type) => (
                    <SelectItem key={type} value={type}>
                      {t(TOKEN_TYPE_LABEL[type])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        </div>
        <Field label={t('panels.tokensValue')}>
          <ValueInput
            type={draft.type}
            self={token?.name ?? null}
            tokens={tokens}
            value={draft.value}
            placeholder={t('panels.tokensValuePlaceholder')}
            disabled={busy || readOnly}
            onChange={(value) => setDraft({ ...draft, value })}
          />
        </Field>
        {themes.length > 0 && <p className="mt-1 text-caption text-ink-faint">{t('panels.tokensThemeValues')}</p>}
        {themes.map((theme) => (
          <Field key={theme} label={t('panels.tokensValueIn', { theme })}>
            <ValueInput
              type={draft.type}
              self={token?.name ?? null}
              tokens={tokens}
              value={draft.themes[theme] ?? ''}
              placeholder={t('panels.tokensValueInherits')}
              disabled={busy || readOnly}
              onChange={(value) => setDraft({ ...draft, themes: { ...draft.themes, [theme]: value } })}
            />
          </Field>
        ))}
        <Field label={t('panels.tokensDescription')}>
          <Input
            variant="well"
            placeholder={t('panels.tokensDescriptionPlaceholder')}
            value={draft.description}
            disabled={busy || readOnly}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </Field>
        {/* Enter anywhere in the form saves */}
        <Button type="submit" className="hidden" aria-hidden tabIndex={-1} disabled={!canSave} />
      </form>
      {error && <p className="mt-2.5 text-copy text-accent-ink">{error}</p>}
      <ModalActions>
        {token && !readOnly && (
          <Button variant="ghost" disabled={busy} onClick={() => setConfirmDelete(true)}>
            {t('common.delete')}
          </Button>
        )}
        {token && (
          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title={t('panels.tokensDeleteTitle', { name: tokenLabel(token.name) })}
            description={t('panels.tokensDeleteDescription')}
            confirmLabel={t('panels.tokensDeleteConfirm')}
            destructive
            onConfirm={() => void remove()}
          />
        )}
        <ModalSpacer />
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          {t('common.cancel')}
        </Button>
        {!readOnly && (
          <Button variant="primary" disabled={!canSave} onClick={() => void save()}>
            {busy ? t('panels.tokensSaving') : t('common.save')}
          </Button>
        )}
      </ModalActions>
    </Modal>
  )
}

const LENGTH_UNITS = ['px', 'rem', 'em', '%'] as const
const RATIO_UNITS = ['', 'px', 'em'] as const
const WEIGHTS = ['100', '200', '300', '400', '500', '600', '700', '800', '900'] as const
const LITERAL = '__literal__'

/** How a type's value is edited: a swatch, a font list, a weight list, a
 *  number with a unit, or a plain ratio. */
function valueKind(type: TokenType): 'color' | 'family' | 'weight' | 'length' | 'ratio' | 'opacity' {
  switch (type) {
    case 'color':
      return 'color'
    case 'fontFamily':
      return 'family'
    case 'fontWeight':
      return 'weight'
    case 'opacity':
      return 'opacity'
    case 'lineHeight':
      return 'ratio'
    default:
      return 'length'
  }
}

function splitLength(value: string): { number: string; unit: string } | null {
  const m = /^(-?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/i.exec(value.trim())
  return m ? { number: m[1]!, unit: m[2]!.toLowerCase() } : null
}

/** A token value edited the way its type wants: a swatch and hex for a
 *  colour, a font list, a weight list, a number with its unit, a ratio, or
 *  an alias of another token of the same type. A value the control cannot
 *  read (a calc(), an unusual unit) falls back to text. */
function ValueInput({
  type,
  self,
  tokens,
  value,
  placeholder,
  disabled,
  onChange,
}: {
  type: TokenType
  /** the token being edited, which may not alias itself */
  self: string | null
  tokens: readonly DesignToken[]
  value: string
  placeholder: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  const t = useT()
  const library = useCanvasFonts((state) => state.fonts)
  const alias = aliasOf(value)
  const peers = sortTokens(tokens.filter((token) => token.type === type && token.name !== self))
  const kind = valueKind(type)
  const resolved = alias ? (resolveToken(tokens, alias) ?? '') : value

  const aliasPick = peers.length > 0 && (
    <Select
      value={alias ?? LITERAL}
      onValueChange={(next) => onChange(next === LITERAL ? (alias ? resolved : value) : `var(${next})`)}
      disabled={disabled}
    >
      <SelectTrigger size="sm" className="w-[120px] flex-none" aria-label={t('panels.tokensAlias')}>
        <SelectValue placeholder={t('panels.tokensAlias')} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={LITERAL}>{t('panels.tokensNoAlias')}</SelectItem>
        {peers.map((token) => (
          <SelectItem key={token.name} value={token.name}>
            {tokenLabel(token.name)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  if (alias)
    return (
      <div className="flex items-center gap-2">
        {kind === 'color' && (
          <span
            className="size-8 flex-none rounded-control shadow-ring"
            style={{ background: resolved || 'transparent' }}
          />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-copy text-ink-soft">{resolved}</span>
        {aliasPick}
      </div>
    )

  let control: ReactNode
  if (kind === 'color') {
    const hex = /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim() : '#ffffff'
    control = (
      <>
        <label
          className="relative size-8 flex-none cursor-pointer overflow-hidden rounded-control shadow-ring"
          style={{ background: value || 'transparent' }}
          title={t('inspector.pickColour')}
        >
          <Input
            type="color"
            variant="bare"
            inputSize="auto"
            aria-label={t('inspector.pickColour')}
            className="absolute -inset-2 h-auto cursor-pointer opacity-0"
            value={hex}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
        <Input
          variant="well"
          className="min-w-0 flex-1 font-mono"
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      </>
    )
  } else if (kind === 'family') {
    const options = [
      ...libraryFamilies(library).map((family) => ({ value: fontStack(family), label: family })),
      ...WEB_FONTS.map((font) => ({ value: webFontStack(font), label: font.family })),
      ...DEVICE_FONTS.map((font) => ({ value: font.value, label: t(font.label) })),
    ]
    if (value && !options.some((o) => o.value === value)) options.unshift({ value, label: value })
    control = (
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="min-w-0 flex-1" aria-label={t('panels.tokensValue')}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  } else if (kind === 'weight') {
    const options = WEIGHTS.includes(value as (typeof WEIGHTS)[number]) || !value ? [...WEIGHTS] : [value, ...WEIGHTS]
    control = (
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="min-w-0 flex-1" aria-label={t('panels.tokensValue')}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((w) => (
            <SelectItem key={w} value={w}>
              {w}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  } else if (kind === 'opacity') {
    control = (
      <Input
        type="number"
        variant="well"
        className="min-w-0 flex-1 font-mono"
        aria-label={t('panels.tokensValue')}
        placeholder={placeholder}
        min={0}
        max={1}
        step={0.05}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  } else {
    const units = kind === 'ratio' ? RATIO_UNITS : LENGTH_UNITS
    const parsed = value ? splitLength(value) : { number: '', unit: '' }
    const fallbackUnit = kind === 'ratio' ? '' : type === 'letterSpacing' ? 'em' : 'px'
    if (!parsed || (parsed.unit && !(units as readonly string[]).includes(parsed.unit)))
      control = (
        <Input
          variant="well"
          className="min-w-0 flex-1 font-mono"
          aria-label={t('panels.tokensValue')}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    else {
      const unit = parsed.number === '' ? fallbackUnit : parsed.unit
      control = (
        <>
          <Input
            type="number"
            variant="well"
            className="min-w-0 flex-1 font-mono"
            aria-label={t('panels.tokensValue')}
            placeholder={placeholder}
            step="any"
            value={parsed.number}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value === '' ? '' : `${e.target.value}${unit}`)}
          />
          <Select
            value={unit || LITERAL}
            onValueChange={(next) =>
              onChange(parsed.number === '' ? '' : `${parsed.number}${next === LITERAL ? '' : next}`)
            }
            disabled={disabled}
          >
            <SelectTrigger size="sm" className="w-[72px] flex-none" aria-label={t('panels.tokensUnit')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {units.map((u) => (
                <SelectItem key={u || LITERAL} value={u || LITERAL}>
                  {u || t('panels.tokensUnitless')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      )
    }
  }

  return (
    <div className="flex items-center gap-2">
      {control}
      {aliasPick}
    </div>
  )
}

/** The canvas's themes in a modal: `default` first and fixed, then each
 *  theme on a row whose name can be retyped (a rename moves its values
 *  along) and removed, and a line to add one; every change saves at once. */
function ThemesModal({ canvasId, themes, onClose }: { canvasId: string; themes: string[]; onClose: () => void }) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const t = useT()
  const typed = draft.trim().toLowerCase()
  const canAdd = isThemeName(typed) && !themes.includes(typed) && themes.length < MAX_TOKEN_THEMES && !busy

  async function save(next: string[], renames: ThemeRename[] = []) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api.setTokenThemes(canvasId, next, renames)
      setDraft('')
    } catch (e) {
      setError(firstMessage(e, t('panels.tokensThemesSaveFailed')))
    } finally {
      setBusy(false)
    }
  }

  function rename(from: string, raw: string) {
    const to = raw.trim().toLowerCase()
    if (to === from) return
    if (!isThemeName(to) || themes.includes(to)) {
      setError(t('panels.tokensThemeInvalid'))
      return
    }
    void save(
      themes.map((theme) => (theme === from ? to : theme)),
      [{ from, to }],
    )
  }

  return (
    <Modal size="sm" onClose={() => !busy && onClose()}>
      <ModalTitle>{t('panels.tokensThemesTitle')}</ModalTitle>
      <ModalLede>{t('panels.tokensThemesLede')}</ModalLede>
      <div className="mt-3 flex flex-col gap-0.5">
        <div className="flex h-8 items-center gap-2 rounded-row px-2">
          <span className="min-w-0 flex-1 truncate font-mono text-label text-ink">{DEFAULT_THEME}</span>
          <span className="text-caption text-ink-faint">{t('panels.tokensDefaultTheme')}</span>
        </div>
        {themes.map((theme) => (
          <ThemeRow
            key={theme}
            theme={theme}
            readOnly={busy}
            onRename={(name) => rename(theme, name)}
            onRemove={() => void save(themes.filter((m) => m !== theme))}
          />
        ))}
        {themes.length < MAX_TOKEN_THEMES && (
          <form
            className="mt-1.5 flex items-center gap-1.5 border-t border-line-soft pt-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (canAdd) void save([...themes, typed])
            }}
          >
            <Input
              variant="well"
              inputSize="sm"
              className="min-w-0 flex-1 font-mono"
              aria-label={t('panels.tokensAddTheme')}
              placeholder={t('panels.tokensThemePlaceholder')}
              value={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
            />
            <IconButton
              size="md"
              variant="primary"
              type="submit"
              aria-label={t('panels.tokensAddTheme')}
              disabled={!canAdd}
            >
              <PlusIcon size="rail" />
            </IconButton>
          </form>
        )}
      </div>
      {error && <p className="mt-2.5 text-copy text-accent-ink">{error}</p>}
      <ModalActions>
        <ModalSpacer />
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          {t('common.close')}
        </Button>
      </ModalActions>
    </Modal>
  )
}

/** One theme: its name as a field that renames on Enter or blur, and its remove control. */
function ThemeRow({
  theme,
  readOnly,
  onRename,
  onRemove,
}: {
  theme: string
  readOnly: boolean
  onRename: (name: string) => void
  onRemove: () => void
}) {
  const [name, setName] = useState(theme)
  const [seen, setSeen] = useState(theme)
  const t = useT()
  if (seen !== theme) {
    setSeen(theme)
    setName(theme)
  }
  return (
    <div className="flex h-8 items-center gap-1 rounded-row pl-1 pr-0.5 hover:bg-sub">
      <Input
        variant="bare"
        inputSize="auto"
        className="h-6 min-w-0 flex-1 px-1 font-mono text-label"
        aria-label={t('panels.tokensRenameTheme', { theme })}
        value={name}
        readOnly={readOnly}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => onRename(name)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') setName(theme)
        }}
      />
      {!readOnly && (
        <IconButton size="sm" variant="danger" aria-label={t('panels.tokensRemoveTheme', { theme })} onClick={onRemove}>
          <XIcon size="rail" />
        </IconButton>
      )}
    </div>
  )
}
