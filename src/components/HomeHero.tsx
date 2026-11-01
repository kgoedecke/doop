import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { DRAFT_OPTIONS, DRAFTS_STORAGE_KEY, isDraftCount, readStoredDrafts, type DraftCount } from '../lib/homePrompt'
import { DoopMark } from './Logo'
import { ModelPicker } from './ModelPicker'
import { BrandMark } from './ui/brand-mark'
import { IconButton } from './ui/icon-button'
import { Chip } from './ui/chip'
import { MenuButton } from './ui/menu-button'
import { Pressable } from './ui/pressable'
import { Textarea } from './ui/textarea'
import {
  DropdownMenu,
  DropdownMenuCaption,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import {
  ArrowUpIcon,
  AttachmentIcon,
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CirclePlusIcon,
  CopyIcon,
  HistoryIcon,
  LayoutTemplateIcon,
  MessageSquareIcon,
  UploadIcon,
} from './ui/icons'
import { useT, type PlainMessageKey } from '../lib/i18n'

/**
 * The home page's front door: the hopping Disc-D, a greeting, a strip of
 * suggestion chips, the composer that starts a canvas from a prompt, and the
 * "connect your designs" bar under it — all over the brand's gradient wave.
 *
 * The composer does not design on this page. A send makes a new canvas, queues
 * the brief as its first board card and opens it, where the agent's work
 * streams in. The draft count asks for that many takes on the same brief.
 */

export interface HeroActions {
  onPrompt: (text: string, drafts: DraftCount) => Promise<void> | void
  onImport: () => void
  onConnectAgents: () => void
  onAutomations: () => void
  onIntegrations: () => void
}

/** a chip either fills the composer with a brief or runs an action */
interface Chip {
  id: string
  label: PlainMessageKey
  icon: ReactNode
  prompt?: PlainMessageKey
  action?: keyof Omit<HeroActions, 'onPrompt'>
}

const chipIcon = { width: 13, height: 13 } as const

const CHIPS: Chip[] = [
  {
    id: 'landing',
    label: 'home.chipLanding',
    icon: <LayoutTemplateIcon {...chipIcon} />,
    prompt: 'home.chipLandingPrompt',
  },
  {
    id: 'recap',
    label: 'home.chipRecap',
    icon: <CalendarIcon {...chipIcon} />,
    prompt: 'home.chipRecapPrompt',
  },
  {
    id: 'changed',
    label: 'home.chipChanged',
    icon: <HistoryIcon {...chipIcon} />,
    prompt: 'home.chipChangedPrompt',
  },
  {
    id: 'automation',
    label: 'home.chipAutomation',
    icon: <span className="font-mono text-caption">/</span>,
    action: 'onAutomations',
  },
  { id: 'agents', label: 'home.chipAgents', icon: <CirclePlusIcon {...chipIcon} />, action: 'onConnectAgents' },
  { id: 'import', label: 'home.chipImport', icon: <UploadIcon {...chipIcon} />, action: 'onImport' },
  {
    id: 'comments',
    label: 'home.chipComments',
    icon: <MessageSquareIcon {...chipIcon} />,
    prompt: 'home.chipCommentsPrompt',
  },
]

/** the beam walks the strip while nobody hovers, like a slow carousel */
const BEAM_STEP_MS = 4000
const MAX_COMPOSER_LINES = 6

function autosize(ta: HTMLTextAreaElement) {
  ta.style.height = 'auto'
  if (!ta.scrollHeight) return
  const line = parseFloat(getComputedStyle(ta).lineHeight) || 22
  ta.style.height = `${Math.min(ta.scrollHeight, Math.round(line * MAX_COMPOSER_LINES))}px`
}

/** the 28 bar heights of one wave copy, laid out twice for the seamless loop */
const WAVE = [
  24, 31, 27, 38, 34, 46, 41, 55, 50, 63, 70, 78, 86, 95, 100, 97, 89, 81, 72, 64, 56, 49, 42, 36, 44, 30, 35, 26,
]

export function HomeHero({
  firstName,
  busy,
  actions,
  focusAt,
}: {
  firstName?: string
  /** a send in flight: the composer locks until the canvas opens */
  busy: boolean
  actions: HeroActions
  /** a timestamp — the rail's "Ask Doop" and ⌘/ ask for the keyboard */
  focusAt: number
}) {
  const [text, setText] = useState('')
  const [drafts, setDrafts] = useState<DraftCount>(() =>
    readStoredDrafts(typeof localStorage === 'undefined' ? undefined : localStorage),
  )
  const [beamAt, setBeamAt] = useState(3)
  const [hovered, setHovered] = useState<number | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const t = useT()

  useLayoutEffect(() => {
    if (inputRef.current) autosize(inputRef.current)
  }, [text])

  useEffect(() => {
    if (focusAt) inputRef.current?.focus()
  }, [focusAt])

  useEffect(() => {
    if (hovered !== null) return
    const timer = window.setInterval(() => setBeamAt((i) => (i + 1) % CHIPS.length), BEAM_STEP_MS)
    return () => window.clearInterval(timer)
  }, [hovered])

  function pickDrafts(n: DraftCount) {
    setDrafts(n)
    try {
      localStorage.setItem(DRAFTS_STORAGE_KEY, String(n))
    } catch {
      /* private mode: the choice lives for this page only */
    }
  }

  function submit() {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    void actions.onPrompt(trimmed, drafts)
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  function runChip(chip: Chip) {
    if (chip.action) return actions[chip.action]()
    if (chip.prompt) {
      setText(t(chip.prompt))
      inputRef.current?.focus()
    }
  }

  const beamOn = hovered ?? beamAt

  return (
    <section className="relative overflow-hidden" data-slot="home-hero">
      {/* the wave: 2 copies of 28 bars, blurred, fading in from the top. It is
          sized to the section, not to pixels, so it ends faded inside the hero
          on a phone as it does on desktop instead of being cut at the edge */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden dark:opacity-60" aria-hidden>
        <div className="hero-wave absolute left-0 top-[20%] flex h-[56%] w-[200%] md:top-[38%] items-end opacity-90 blur-[22px] saturate-[1.15] [mask-image:linear-gradient(to_bottom,transparent_0%,#000_42%,#000_82%,transparent)]">
          {[...WAVE, ...WAVE].map((h, i) => (
            <i key={i} style={{ height: `${h}%` }} />
          ))}
        </div>
      </div>

      <div className="relative px-4 pt-10 text-center md:pt-14">
        <span className="mx-auto mb-4 block h-[52px] w-[40px] text-ink md:mb-5 md:h-[62px] md:w-[48px]">
          <DoopMark animated size="fill" className="block" />
        </span>
        <h1 className="font-hero text-title font-light leading-none md:text-display">
          {t('home.greeting')}
          {firstName ? ', ' : ''}
          {firstName && <span className="text-ink-faint">{firstName}</span>}
        </h1>
      </div>

      {/* the chip strip: wider than its box, clipped and faded at both ends */}
      <div className="relative mx-auto mt-8 hidden h-8 max-w-[1100px] px-[60px] md:block md:mt-10">
        <ChevronLeftIcon
          width={14}
          height={14}
          strokeWidth={1.75}
          className="absolute left-5 top-[9px] text-ink-soft"
          aria-hidden
        />
        <div className="absolute inset-x-[54px] -top-[14px] flex h-[74px] items-start justify-center overflow-hidden pb-7 pt-[14px] [mask-image:linear-gradient(90deg,transparent,#000_14%,#000_86%,transparent)]">
          <div className="flex flex-none gap-3" onMouseLeave={() => setHovered(null)}>
            {CHIPS.map((chip, i) => {
              const on = i === beamOn
              return (
                <Chip
                  key={chip.id}
                  icon={chip.icon}
                  on={on}
                  onMouseEnter={() => setHovered(i)}
                  onFocus={() => setHovered(i)}
                  onBlur={() => setHovered(null)}
                  onClick={() => runChip(chip)}
                >
                  {on && (
                    <span className="chip-beam motion-reduce:animate-none" aria-hidden>
                      <i />
                    </span>
                  )}
                  {t(chip.label)}
                </Chip>
              )
            })}
          </div>
        </div>
        <ChevronRightIcon
          width={14}
          height={14}
          strokeWidth={1.75}
          className="absolute right-5 top-[9px] text-ink-soft"
          aria-hidden
        />
      </div>

      {/* the composer */}
      <div className="relative mx-auto mt-6 w-full max-w-[740px] px-4 md:mt-[34px] md:px-0">
        <div className="rounded-panel bg-surface px-[18px] pb-3 pt-5 shadow-float">
          <Textarea
            ref={inputRef}
            variant="bare"
            rows={1}
            value={text}
            disabled={busy}
            placeholder={t('home.composerPlaceholder')}
            aria-label={t('home.composerAria')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            className="min-h-[52px] text-lead placeholder:text-ink-ghost md:text-lead"
          />
          <div className="mt-1 flex items-center gap-3 text-body text-ink-soft md:gap-5">
            <Pressable
              layout="inline"
              focus="ring"
              className="gap-[7px] rounded-row text-ink-soft transition-colors hover:text-ink"
              onClick={actions.onImport}
              title={t('home.attachTitle')}
            >
              <AttachmentIcon width={14} height={14} /> {t('home.files')}
            </Pressable>
            <span className="flex-1" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <MenuButton
                  variant="quiet"
                  aria-label={t('home.draftsAria', { count: drafts })}
                  className="whitespace-nowrap"
                  icon={<CopyIcon width={14} height={14} />}
                >
                  {t('home.drafts', { count: drafts })}
                </MenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="end" width="md">
                <DropdownMenuCaption>{t('home.draftsCaption')}</DropdownMenuCaption>
                <DropdownMenuRadioGroup
                  value={String(drafts)}
                  onValueChange={(next) => {
                    const n = Number(next)
                    if (isDraftCount(n)) pickDrafts(n)
                  }}
                >
                  {DRAFT_OPTIONS.map((n) => (
                    <DropdownMenuRadioItem
                      key={n}
                      value={String(n)}
                      description={t('home.draftsDescription', { count: n })}
                    >
                      {t('home.drafts', { count: n })}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <ModelPicker disabled={busy} />
            <IconButton
              variant="primary"
              size="lg"
              shape="round"
              aria-label={t('home.send')}
              disabled={busy || !text.trim()}
              onClick={submit}
            >
              <ArrowUpIcon width={14} height={14} strokeWidth={1.75} />
            </IconButton>
          </div>
        </div>
        <Pressable
          focus="ring"
          onClick={actions.onIntegrations}
          className="group mx-[14px] flex w-[calc(100%-28px)] items-center rounded-b-card bg-sub px-5 pb-2.5 pt-3 text-body text-ink-soft transition-colors hover:text-ink"
        >
          {t('home.connectDesigns')}
          <ChevronRightIcon
            width={12}
            height={12}
            className="ml-1.5 -translate-x-0.5 text-ink-faint opacity-0 blur-[2px] transition-[opacity,transform,filter] duration-fast ease-out-quad group-hover:translate-x-0 group-hover:opacity-100 group-hover:blur-none motion-reduce:transition-none"
            aria-hidden
          />
          {/* the marks rest a little faded and desaturated; the bar's hover wakes the
              row, and the mark under the pointer comes fully to life and lifts */}
          <span
            className="marks ml-auto flex items-center gap-[9px] [&>*]:opacity-75 [&>*]:saturate-[.8] [&>*]:transition-[opacity,filter,transform] [&>*]:duration-fast [&>*]:ease-out-quad group-hover:[&>*]:opacity-90 group-hover:[&>*]:saturate-[.95] [&>*:hover]:-translate-y-px [&>*:hover]:!opacity-100 [&>*:hover]:!saturate-100 motion-reduce:[&>*]:transition-none"
            aria-hidden
          >
            <span className="grid size-4 place-items-center rounded-tag bg-surface shadow-ring">
              <BrandMark brand="figma" size={12} />
            </span>
            <BrandMark brand="github" size={16} className="text-ink" />
            <BrandMark brand="canva" size={16} />
            <BrandMark brand="photoshop" size={16} />
          </span>
        </Pressable>
      </div>
    </section>
  )
}
