import { useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import {
  DEFAULT_THEME,
  MAX_TOKEN_THEMES,
  aliasOf,
  effectiveValue,
  frameTheme,
  nextTokenName,
  TOKEN_GROUPS,
  isThemeName,
  isTokenName,
  normalizeTokenName,
  resolveToken,
  tokenLabel,
  sortTokens,
  withFrameTheme,
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
import { recordUpdate, trackSave } from '../lib/history'
import { usePageCanvas } from '../lib/pages'
import { Button } from './ui/button'
import { Pressable } from './ui/pressable'
import { Input } from './ui/input'
import { ListHint } from './ui/list'
import { Modal, ModalActions, ModalLede, ModalSpacer, ModalTitle } from './ui/modal'
import { sectionHeading } from './PagesPanel'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './ui/context-menu'
import { ConfirmDialog } from './ui/alert-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import {
  BlendIcon,
  BoldIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DesktopIcon,
  PaletteIcon,
  PlusIcon,
  RadiusIcon,
  RulerIcon,
  SpaceIcon,
  SquareDashedIcon,
  TextIcon,
  TextSizeIcon,
  VerticalPaddingIcon,
  XIcon,
} from './ui/icons'
import { type PlainMessageKey, useT } from '@/lib/i18n'
import { useValueScrub } from '@/hooks/use-value-scrub'
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

/** The glyph that leads each type's group row. */
const TOKEN_TYPE_ICON: Record<TokenType, typeof PaletteIcon> = {
  color: PaletteIcon,
  opacity: BlendIcon,
  radius: RadiusIcon,
  spacing: RulerIcon,
  container: SquareDashedIcon,
  breakpoint: DesktopIcon,
  fontFamily: TextIcon,
  fontWeight: BoldIcon,
  fontSize: TextSizeIcon,
  lineHeight: VerticalPaddingIcon,
  letterSpacing: SpaceIcon,
}

function firstMessage(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message.replace(/^\d+\s*/, '') : fallback
}

const sectionBtn = 'size-5 rounded-tag text-ink-faint hover:bg-paper-deep hover:text-ink'

/** The Tokens tab: the canvas's design tokens by type, shown under one
 *  theme at a time, with the theme picker and the add button on one line. */
export function TokensSection() {
  const canvasId = useStore((s) => s.canvas?.id)
  const tokens = useStore((s) => s.canvas?.tokens ?? [])
  const themes = useStore((s) => s.canvas?.tokenThemes ?? [])
  const readOnly = useStore((s) => !canEditOpenCanvas(s))
  /** the open token's name, a type to create one of, or null */
  const [open, setOpen] = useState<{ name: string } | { create: TokenType } | null>(null)
  /* the frames a pick applies to: the selected ones, else every frame on the page */
  const pageFrames = usePageCanvas()?.frames ?? []
  const frames = useStore((s) => s.canvas?.frames)
  const selectedIds = useStore((s) => s.selectedIds)
  const selectedId = useStore((s) => s.selectedId)
  /* derived here, not in the selector: a fresh array from a selector is a
     change on every store message, cursors and cameras included */
  const selectedFrames = useMemo(() => {
    const ids = new Set(selectedIds.length ? selectedIds : selectedId ? [selectedId] : [])
    return (frames ?? []).filter((f) => ids.has(f.id))
  }, [frames, selectedIds, selectedId])
  const targets = selectedFrames.length ? selectedFrames : pageFrames
  /** the theme the rows show: what the target frames wear right now, so a
   *  new selection, an undo or a rename keeps the tick and the values in step */
  /* with frames to switch, the shown theme is what they wear; a viewer, a
     commenter or an empty page browses the list through a local pick instead */
  const [preview, setPreview] = useState<string | null>(null)
  const switching = !readOnly && targets.length > 0
  const viewTheme = switching ? frameTheme(targets[0]!.html) : preview
  const [themeBusy, setThemeBusy] = useState(false)
  const [themeError, setThemeError] = useState<string | null>(null)
  /** the type groups folded shut */
  const [folded, setFolded] = useState<Set<TokenType>>(() => new Set())
  const t = useT()
  if (!canvasId) return null

  async function saveThemes(next: string[], renames: ThemeRename[] = []) {
    if (themeBusy || !canvasId) return
    setThemeBusy(true)
    setThemeError(null)
    try {
      await api.setTokenThemes(canvasId, next, renames)
    } catch (e) {
      setThemeError(firstMessage(e, t('panels.tokensThemesSaveFailed')))
    } finally {
      setThemeBusy(false)
    }
  }

  /** Show a theme: the rows switch to its values, and the target frames
   *  switch their root to it, one undo step per frame. */
  function showTheme(theme: string | null) {
    setPreview(theme)
    if (!switching) return
    for (const frame of targets) {
      const before = frame.html
      const html = withFrameTheme(before, theme)
      if (html === before) continue
      useStore.getState().patchFrameLocal(frame.id, { html })
      recordUpdate(frame.id, { html: before }, { html }, true)
      trackSave(api.updateFrame(frame.id, { html }).catch(console.error))
    }
  }

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
            aria-label={t('panels.tokensAddTheme')}
            title={t('panels.tokensAddTheme')}
            disabled={themeBusy || themes.length >= MAX_TOKEN_THEMES}
            onClick={() => void saveThemes([...themes, nextThemeName(themes)])}
          >
            <PlusIcon className="size-3.5" />
          </Button>
        )}
      </div>
      {/* every theme on a row, as the pages are; the one the rows show wears
          the tick, and a right click renames or deletes one */}
      <div className="px-2 pb-1" role="radiogroup" aria-label={t('panels.tokensTheme')}>
        {[DEFAULT_THEME, ...themes].map((theme) => (
          <ThemeRow
            key={theme}
            theme={theme}
            on={(shown ?? DEFAULT_THEME) === theme}
            fixed={theme === DEFAULT_THEME}
            readOnly={readOnly || themeBusy}
            onShow={() => showTheme(theme === DEFAULT_THEME ? null : theme)}
            onRename={(to) =>
              void saveThemes(
                themes.map((m) => (m === theme ? to : m)),
                [{ from: theme, to }],
              )
            }
            onDelete={() => void saveThemes(themes.filter((m) => m !== theme))}
          />
        ))}
        {themeError && <p className="px-2.5 pt-1 text-caption text-accent-ink">{themeError}</p>}
      </div>
      {/* Tokens: the heading with its plus, the rows by type under it */}
      <div className={cn('mt-1.5 flex h-6 flex-none items-center justify-between pr-2.5 pl-3.5', sectionHeading)}>
        <span className={sectionHeading}>{t('panels.tokensTitle')}</span>
        {!readOnly && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="bare"
                size="icon-sm"
                className={sectionBtn}
                aria-label={t('panels.tokensNew')}
                title={t('panels.tokensNew')}
              >
                <PlusIcon className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent width="sm">
              {TOKEN_GROUPS.map((group, i) => (
                <div key={group.join()}>
                  {i > 0 && <DropdownMenuSeparator />}
                  {group.map((type) => (
                    <DropdownMenuItem key={type} onSelect={() => setOpen({ create: type })}>
                      {t(TOKEN_TYPE_LABEL[type])}
                    </DropdownMenuItem>
                  ))}
                </div>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {sorted.length === 0 && <ListHint>{t('panels.tokensHint')}</ListHint>}
      <div className="px-2 pb-1">
        {TOKEN_GROUPS.flat().map((type) => {
          const rows = sorted.filter((token) => token.type === type)
          if (!rows.length) return null
          const Icon = TOKEN_TYPE_ICON[type]
          const shut = folded.has(type)
          return (
            <div key={type}>
              {/* the group row, folded like a frame in the layer tree: chevron, glyph, name */}
              <Pressable
                aria-expanded={!shut}
                className="flex h-[27px] w-full items-center gap-1 rounded-row pr-2.5 pl-1 text-left text-body text-ink-soft hover:bg-sub"
                onClick={() =>
                  setFolded((prev) => {
                    const next = new Set(prev)
                    if (next.has(type)) next.delete(type)
                    else next.add(type)
                    return next
                  })
                }
              >
                <span className="grid size-4 flex-none place-items-center text-ink-faint">
                  {shut ? <ChevronRightIcon className="size-3" /> : <ChevronDownIcon className="size-3" />}
                </span>
                <span className="grid size-4 flex-none place-items-center text-ink-faint">
                  <Icon className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1 truncate pl-0.5">{t(TOKEN_GROUP_LABEL[type])}</span>
              </Pressable>
              {!shut &&
                rows.map((token) => (
                  <Pressable
                    key={token.name}
                    className="flex h-[27px] w-full items-center gap-2 rounded-row pr-2.5 pl-6 text-left hover:bg-sub"
                    onClick={() => setOpen({ name: token.name })}
                  >
                    <TokenSwatch token={token} tokens={tokens} theme={shown ?? undefined} size={12} />
                    <span className="min-w-0 flex-1 truncate font-mono text-label text-ink">
                      {tokenLabel(token.name)}
                    </span>
                    <span
                      className={cn(
                        'max-w-[45%] flex-none truncate font-mono text-caption',
                        shown && token.themes?.[shown] === undefined ? 'text-ink-faint' : 'text-ink-soft',
                      )}
                      title={shown && token.themes?.[shown] === undefined ? t('panels.tokensValueInherits') : undefined}
                    >
                      {effectiveValue(token, shown ?? undefined)}
                    </span>
                  </Pressable>
                ))}
            </div>
          )
        })}
      </div>
      {open !== null && (
        <TokenModal
          canvasId={canvasId}
          name={'name' in open ? open.name : null}
          createType={'create' in open ? open.create : null}
          currentTheme={shown}
          onClose={() => setOpen(null)}
        />
      )}
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

function draftOf(
  token: DesignToken | null,
  createType: TokenType | null,
  tokens: readonly DesignToken[],
  initialValue = '',
): Draft {
  const type = token?.type ?? createType ?? 'color'
  return {
    name: tokenLabel(token ? token.name : nextTokenName(tokens, type)),
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
  currentTheme,
  onCreated,
  onClose,
}: {
  canvasId: string
  name: string | null
  createType: TokenType | null
  initialValue?: string
  /** the theme the frames show; its value row is highlighted */
  currentTheme?: string | null
  onCreated?: (name: string) => void
  onClose: () => void
}) {
  const token = useStore((s) => s.canvas?.tokens?.find((d) => d.name === name) ?? null)
  const tokens = useStore((s) => s.canvas?.tokens ?? [])
  const themes = useStore((s) => s.canvas?.tokenThemes ?? [])
  const readOnly = useStore((s) => !canEditOpenCanvas(s))
  const creating = name === null
  /** the token as the modal opened: the draft is diffed against this, not the
   *  live row, so a field a teammate changed meanwhile is not sent back stale */
  const [opened] = useState(token)
  const [draft, setDraft] = useState<Draft>(() => draftOf(opened, createType, tokens, initialValue))
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
        /* only the fields the person changed, so a concurrent edit elsewhere is kept */
        const was = opened!
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
    <Modal size="lg" onClose={() => !busy && onClose()}>
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
        {/* each field on a row: the label at the left, the control filling the rest */}
        <Row label={t('panels.tokensName')}>
          <Input
            variant="well"
            className="font-mono"
            autoFocus={creating}
            aria-label={t('panels.tokensName')}
            value={draft.name}
            disabled={busy || readOnly}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </Row>
        {/* every theme's value on its own row, the default first; a themed one
            can go back to following the default with the reset at its end */}
        <div className="grid grid-cols-[132px_minmax(0,1fr)] items-start gap-3">
          <span data-row-label className="pt-2 text-label text-ink-soft">
            {t('panels.tokensValue')}
          </span>
          <div className="flex min-w-0 flex-col gap-1.5">
            {[null, ...themes].map((theme) => {
              return (
                <div
                  key={theme ?? DEFAULT_THEME}
                  className={cn(
                    '-mx-1.5 flex items-center gap-2 rounded-row px-1.5 py-1',
                    (theme ?? null) === (currentTheme ?? null) && 'bg-sub',
                  )}
                >
                  {themes.length > 0 && (
                    <span
                      data-theme-label
                      className="w-[72px] flex-none truncate font-mono text-caption text-ink-faint"
                    >
                      {theme ?? DEFAULT_THEME}
                    </span>
                  )}
                  <ValueInput
                    type={draft.type}
                    value={theme ? (draft.themes[theme] ?? '') : draft.value}
                    placeholder={theme ? t('panels.tokensValueInherits') : t('panels.tokensValuePlaceholder')}
                    disabled={busy || readOnly}
                    onChange={(value) =>
                      setDraft(theme ? { ...draft, themes: { ...draft.themes, [theme]: value } } : { ...draft, value })
                    }
                    onReset={theme ? () => setDraft({ ...draft, themes: { ...draft.themes, [theme]: '' } }) : undefined}
                  />
                </div>
              )
            })}
          </div>
        </div>
        <Row label={t('panels.tokensDescription')}>
          <Input
            variant="well"
            placeholder={t('panels.tokensDescriptionPlaceholder')}
            value={draft.description}
            disabled={busy || readOnly}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </Row>
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
 *  colour, a font list, a weight list, a number with its unit, a ratio. A
 *  value the control cannot read (a calc(), an alias an agent wrote) falls
 *  back to text. */
function ValueInput({
  type,
  value,
  placeholder,
  disabled,
  onChange,
  onReset,
}: {
  type: TokenType
  value: string
  placeholder: string
  disabled: boolean
  onChange: (value: string) => void
  /** a themed value: the ✕ inside the field puts it back to following the default */
  onReset?: () => void
}) {
  const t = useT()
  const library = useCanvasFonts((state) => state.fonts)
  const alias = aliasOf(value)
  const kind = valueKind(type)
  /* the number kinds scrub from their type's glyph, as the Design panel's fields do from their unit */
  const numeric = kind === 'length' || kind === 'ratio' || kind === 'opacity'
  const parsedForScrub = numeric && value ? splitLength(value) : null
  /* an empty field (a theme following the default) scrubs from zero in the type's unit */
  const scrubUnit = parsedForScrub?.unit || (kind === 'length' ? (type === 'letterSpacing' ? 'em' : 'px') : '')
  const scrub = useValueScrub({
    value: value ? (parsedForScrub?.number ?? '') : '0',
    enabled:
      numeric && !alias && !disabled && (value === '' || (parsedForScrub !== null && parsedForScrub.number !== '')),
    min: kind === 'opacity' ? 0 : -Infinity,
    max: kind === 'opacity' ? 1 : Infinity,
    onChange: (next) => onChange(`${next}${scrubUnit}`),
  })
  const canReset = !!onReset && value.trim() !== '' && !disabled
  /* the field with the reset sitting inside its right end */
  const withReset = (field: ReactNode) =>
    onReset ? (
      <span className="relative min-w-0 flex-1">
        {field}
        {canReset && (
          <Button
            variant="bare"
            size="icon-sm"
            className="absolute top-1/2 right-1 size-6 -translate-y-1/2 rounded-tag text-ink-faint hover:text-ink"
            aria-label={t('panels.tokensResetTheme')}
            title={t('panels.tokensResetTheme')}
            onClick={onReset}
          >
            <XIcon className="size-3.5" />
          </Button>
        )}
      </span>
    ) : (
      field
    )
  const Glyph = TOKEN_TYPE_ICON[type]
  /** A number in a well with its type's glyph at the left, the scrub handle,
   *  and the reset at the right, as the Design panel's fields are built. */
  const numberField = (inputProps: ComponentProps<'input'>) => (
    <span
      className={cn(
        'flex h-9 min-w-0 flex-1 items-center gap-2 rounded-pill border border-line bg-paper pr-2 pl-2.5 focus-within:border-ink focus-within:bg-surface',
        disabled && 'opacity-50',
      )}
    >
      <span
        className={cn(
          'grid size-5 flex-none place-items-center rounded-tag text-ink-faint',
          scrub.canScrub && 'cursor-ew-resize hover:bg-sub hover:text-ink',
          scrub.scrubbing && 'bg-sub text-ink',
        )}
        title={scrub.canScrub ? t('inspector.scrubHint') : undefined}
        onPointerDown={scrub.onPointerDown}
        onClick={(e) => scrub.canScrub && e.preventDefault()}
        aria-hidden
      >
        <Glyph className="size-3.5" />
      </span>
      <Input
        type="number"
        variant="bare"
        inputSize="auto"
        className="h-full w-full min-w-0 font-mono"
        aria-label={t('panels.tokensValue')}
        disabled={disabled}
        {...inputProps}
      />
      {canReset && (
        <Button
          variant="bare"
          size="icon-sm"
          className="size-6 flex-none rounded-tag text-ink-faint hover:text-ink"
          aria-label={t('panels.tokensResetTheme')}
          title={t('panels.tokensResetTheme')}
          onClick={onReset}
        >
          <XIcon className="size-3.5" />
        </Button>
      )}
    </span>
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
        {withReset(
          <Input
            variant="well"
            className={cn('w-full min-w-0 font-mono', onReset && 'pr-8')}
            placeholder={placeholder}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />,
        )}
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
  } else if (kind === 'opacity' && (value === '' || /^(\d+\.?\d*|\.\d+)$/.test(value.trim()))) {
    control = numberField({
      placeholder,
      min: 0,
      max: 1,
      step: 0.05,
      value,
      onChange: (e) => onChange(e.target.value),
    })
  } else if (kind === 'opacity') {
    /* an alias or any other expression an agent wrote: as text, like a length's fallback */
    control = withReset(
      <Input
        variant="well"
        className={cn('w-full min-w-0 font-mono', onReset && 'pr-8')}
        aria-label={t('panels.tokensValue')}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />,
    )
  } else {
    const units = kind === 'ratio' ? RATIO_UNITS : LENGTH_UNITS
    const parsed = value ? splitLength(value) : { number: '', unit: '' }
    const fallbackUnit = kind === 'ratio' ? '' : type === 'letterSpacing' ? 'em' : 'px'
    if (!parsed || (parsed.unit && !(units as readonly string[]).includes(parsed.unit)))
      control = withReset(
        <Input
          variant="well"
          className={cn('w-full min-w-0 font-mono', onReset && 'pr-8')}
          aria-label={t('panels.tokensValue')}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />,
      )
    else {
      const unit = parsed.number === '' ? fallbackUnit : parsed.unit
      control = (
        <>
          {numberField({
            placeholder,
            step: 'any',
            value: parsed.number,
            onChange: (e) => onChange(e.target.value === '' ? '' : `${e.target.value}${unit}`),
          })}
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
    <div className="flex w-full items-center gap-2">
      {control}
      {(kind === 'family' || kind === 'weight') && canReset && (
        <Button
          variant="bare"
          size="icon-sm"
          className="size-7 flex-none rounded-tag text-ink-faint hover:text-ink"
          aria-label={t('panels.tokensResetTheme')}
          title={t('panels.tokensResetTheme')}
          onClick={onReset}
        >
          <XIcon className="size-3.5" />
        </Button>
      )}
    </div>
  )
}

/** One row of the token form: the label in a fixed column, the control filling the rest. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  /* a div, not a label: a colour row holds a swatch label of its own */
  return (
    <div className="grid grid-cols-[132px_minmax(0,1fr)] items-center gap-3">
      <span data-row-label className="text-label text-ink-soft">
        {label}
      </span>
      <div className="flex min-w-0 items-center">{children}</div>
    </div>
  )
}

/** The next free `theme-N` name. */
function nextThemeName(themes: readonly string[]): string {
  for (let i = 1; ; i++) if (!themes.includes(`theme-${i}`)) return `theme-${i}`
}

/** One theme on a row: click shows its values (the tick), a right click
 *  renames it in place or deletes it; `default` is fixed. */
function ThemeRow({
  theme,
  on,
  fixed,
  readOnly,
  onShow,
  onRename,
  onDelete,
}: {
  theme: string
  on: boolean
  fixed: boolean
  readOnly: boolean
  onShow: () => void
  onRename: (to: string) => void
  onDelete: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(theme)
  const [bad, setBad] = useState(false)
  /* the menu hands focus back to the row as it closes, which would blur the
     rename field it just opened; the ref is set before the state lands */
  const renameStarting = useRef(false)
  const openedAt = useRef(0)
  const reclaimed = useRef(false)
  const t = useT()

  function startRename() {
    openedAt.current = Date.now()
    reclaimed.current = false
    setName(theme)
    setRenaming(true)
  }

  function commit() {
    const to = name.trim().toLowerCase()
    setRenaming(false)
    setBad(false)
    if (to === theme) return
    if (!isThemeName(to)) {
      setBad(true)
      setName(theme)
      return
    }
    onRename(to)
  }

  const row = (
    <div
      className={cn(
        'group flex h-[27px] items-center gap-1 rounded-row pr-2.5 pl-2.5 text-body text-ink-soft hover:bg-sub',
        on && 'bg-paper-deep text-ink hover:bg-paper-deep',
      )}
    >
      <span className="grid size-4 flex-none place-items-center text-ink">
        {on && <CheckIcon className="size-3.5" />}
      </span>
      {renaming ? (
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault()
            commit()
          }}
        >
          <Input
            variant="bare"
            inputSize="auto"
            autoFocus
            aria-label={t('panels.tokensRenameTheme', { theme })}
            className="h-6 w-full rounded-tag bg-surface px-1.5 text-body text-ink shadow-elevation-1-focus"
            value={name}
            onFocus={(e) => e.target.select()}
            onChange={(e) => setName(e.target.value)}
            onBlur={(e) => {
              /* the menu hands focus back to the row as it closes, right after
                 the field opened: take it back rather than commit */
              if (!reclaimed.current && Date.now() - openedAt.current < 250) {
                reclaimed.current = true
                const field = e.target
                setTimeout(() => field.focus(), 0)
                return
              }
              commit()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setName(theme)
                setRenaming(false)
              }
            }}
          />
        </form>
      ) : (
        <Pressable
          role="radio"
          aria-checked={on}
          className={cn('min-w-0 flex-1 truncate py-1.5 pl-0.5 text-left', on && 'font-medium')}
          onClick={onShow}
          onDoubleClick={() => {
            if (!fixed && !readOnly) startRename()
          }}
        >
          {theme}
        </Pressable>
      )}
      {bad && <span className="text-caption text-accent-ink">{t('panels.tokensThemeInvalidShort')}</span>}
    </div>
  )
  if (fixed || readOnly) return row
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent
        onCloseAutoFocus={(e) => {
          if (renameStarting.current) {
            renameStarting.current = false
            e.preventDefault()
          }
        }}
      >
        <ContextMenuItem
          onSelect={() => {
            renameStarting.current = true
            startRename()
          }}
        >
          {t('panels.tokensRenameThemeItem')}
        </ContextMenuItem>
        <ContextMenuItem tone="danger" onSelect={onDelete}>
          {t('panels.tokensDeleteTheme')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
