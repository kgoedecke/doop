import { useEffect, useMemo, useRef, useState } from 'react'
import {
  COMMUNITY_CATEGORIES,
  COMMUNITY_CATEGORY_LABELS,
  PREVIEW_MAX_HEIGHT,
  type CommunityCategory,
  type CommunityItem,
} from '../../shared/types'
import { api } from '../lib/api'
import { navigate } from '../App'
import { Logo } from '../components/Logo'
import { timeAgo } from '../lib/time'
import { AccountMenu, ConnectCard, IconCommunity, IconGrid } from '../components/DashShell'
import { posthog } from '../lib/posthog'
import { openCanvasTab } from '../lib/desktop'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Input } from '../components/ui/input'
import { Card, cardVariants } from '../components/ui/card'
import { Skeleton } from '../components/ui/skeleton'
import { Wordmark } from '../components/ui/wordmark'
import { Segmented, SegmentedItem } from '../components/ui/segmented'
import { ToggleChipGroup, ToggleChipItem } from '../components/ui/toggle-chip'
import { Modal, ModalEyebrow, ModalTitle } from '../components/ui/modal'
import { CopyIcon, XIcon } from '../components/ui/icons'
import { Toast } from '../components/ui/toast'
import {
  DashContent,
  DashHeader,
  DashLayout,
  DashMain,
  DashSectionLabel,
  DashSidebar,
  DashSubtitle,
  DashTitle,
} from '../components/ui/dash'
import { NavItem } from './Home'
import { cn } from '@/lib/utils'

type Shelf = 'all' | CommunityCategory
type Sort = 'trending' | 'newest'

/* a gallery tile: the raised Card surface, made clickable — the same tile as Home */
const cardCls = cn(
  cardVariants({ tone: 'raised' }),
  'group relative z-[2] transform-gpu overflow-hidden rounded-[14px] p-0 text-left text-ink',
  'bg-[color-mix(in_srgb,var(--surface)_72%,transparent)] backdrop-blur-[6px]',
)

/** The community gallery: designs people have published for others to
 *  preview and copy. Browsing is read-only by construction — a card shows
 *  rendered frame images, and the only way in is a copy of your own. */
export function Community() {
  const [items, setItems] = useState<CommunityItem[] | null>(null)
  const [shelf, setShelf] = useState<Shelf>('all')
  const [sort, setSort] = useState<Sort>('trending')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<CommunityItem | null>(null)
  const [copyingId, setCopyingId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api.listCommunity().then(setItems).catch(console.error)
    posthog.capture('community_viewed')
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      } else if (e.key === 'Escape' && document.activeElement === searchRef.current) {
        searchRef.current?.blur()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  async function copy(item: CommunityItem) {
    if (copyingId) return
    setCopyingId(item.id)
    try {
      const canvas = await api.copyCommunityCanvas(item.id)
      posthog.capture('community_canvas_copied', { source: item.id, category: item.category })
      /* the count went up server-side; reflect it without a refetch */
      setItems((list) => list?.map((i) => (i.id === item.id ? { ...i, copyCount: i.copyCount + 1 } : i)) ?? null)
      setOpen(null)
      if (!openCanvasTab(canvas.id, canvas.name)) navigate(`/c/${canvas.id}`)
    } catch (error) {
      console.error(error)
      showToast('Couldn’t copy this design')
    } finally {
      setCopyingId(null)
    }
  }

  function showToast(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(null), 2400)
  }

  const counts = useMemo(() => {
    const map = new Map<Shelf, number>([['all', items?.length ?? 0]])
    for (const item of items ?? []) map.set(item.category, (map.get(item.category) ?? 0) + 1)
    return map
  }, [items])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (items ?? [])
      .filter((item) => shelf === 'all' || item.category === shelf)
      .filter(
        (item) =>
          !q ||
          item.name.toLowerCase().includes(q) ||
          (item.description ?? '').toLowerCase().includes(q) ||
          item.authorName.toLowerCase().includes(q),
      )
      .sort((a, b) =>
        sort === 'trending'
          ? b.copyCount - a.copyCount || b.publishedAt - a.publishedAt
          : b.publishedAt - a.publishedAt,
      )
  }, [items, shelf, query, sort])

  /* shelves with nothing on them stay out of the rail — an empty gallery
     should read as one quiet invitation, not six */
  const shelves = COMMUNITY_CATEGORIES.filter((c) => (counts.get(c) ?? 0) > 0)
  const empty = items !== null && items.length === 0

  return (
    <DashLayout>
      <DashSidebar>
        <Wordmark size="sm" className="px-2 pb-5 text-[17px]" />

        <nav className="flex flex-col gap-0.5">
          <NavItem icon={<IconGrid />} label="My canvases" on={false} go={() => navigate('/')} />
        </nav>

        <DashSectionLabel>Explore</DashSectionLabel>
        <nav className="flex flex-col gap-0.5">
          <NavItem
            icon={<IconCommunity />}
            label="Community"
            count={counts.get('all')}
            on={shelf === 'all'}
            go={() => setShelf('all')}
          />
          {shelves.map((c) => (
            <NavItem
              key={c}
              icon={<span className="w-[15px]" />}
              label={COMMUNITY_CATEGORY_LABELS[c]}
              count={counts.get(c)}
              on={shelf === c}
              go={() => setShelf(c)}
            />
          ))}
        </nav>

        <div className="min-h-6 flex-1" />
        <ConnectCard />
      </DashSidebar>

      <DashMain>
        <DashHeader className="max-md:min-h-[104px]">
          <Button
            variant="bare"
            className="min-h-10 gap-2 p-0 font-display text-base font-extrabold text-ink hover:bg-transparent md:hidden"
            onClick={() => navigate('/')}
            aria-label="Doop home"
          >
            <Logo className="size-7" /> Doop
          </Button>
          <label className="order-2 flex h-10 max-w-none flex-1 basis-full items-center gap-[9px] rounded-[10px] border border-line bg-surface px-[11px] text-ink-faint focus-within:border-ink-faint md:order-none md:h-[34px] md:max-w-[400px] md:basis-auto">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.2-3.2" />
            </svg>
            <Input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the gallery"
              aria-label="Search the gallery"
              variant="bare"
              inputSize="auto"
              className="flex-1 md:text-[13px]"
            />
            <kbd className="hidden flex-none rounded-[5px] border border-line px-[5px] py-px font-mono text-[10px] text-ink-faint md:block">
              ⌘K
            </kbd>
          </label>
          <span className="flex-1" />
          <Button variant="ghost" className="min-h-10 md:min-h-0" onClick={() => navigate('/')}>
            ← My canvases
          </Button>
          <AccountMenu />
        </DashHeader>

        <DashContent>
          <div className="flex items-start gap-4 md:items-end">
            <div>
              <DashTitle>
                Community<em className="not-italic text-brand">.</em>
              </DashTitle>
              <DashSubtitle>
                {items === null
                  ? '…'
                  : `${items.length} ${items.length === 1 ? 'design' : 'designs'} people published to copy and remix`}
              </DashSubtitle>
            </div>
            <Segmented
              className="ml-auto flex-none"
              aria-label="Sort"
              value={sort}
              onValueChange={(next) => setSort(next as Sort)}
            >
              <SegmentedItem value="trending">Trending</SegmentedItem>
              <SegmentedItem value="newest">Newest</SegmentedItem>
            </Segmented>
          </div>

          {shelves.length > 0 && (
            <ToggleChipGroup
              className="mt-4 gap-1.5 md:hidden"
              aria-label="Shelf"
              value={shelf}
              onValueChange={(next) => setShelf(next as Shelf)}
            >
              <ToggleChipItem value="all" className="px-2.5 py-1 text-[12px]">
                All · {counts.get('all')}
              </ToggleChipItem>
              {shelves.map((c) => (
                <ToggleChipItem key={c} value={c} className="px-2.5 py-1 text-[12px]">
                  {COMMUNITY_CATEGORY_LABELS[c]} · {counts.get(c)}
                </ToggleChipItem>
              ))}
            </ToggleChipGroup>
          )}

          {empty ? (
            <Card className="mt-7 max-w-[560px] rounded-[18px] px-5 pb-6 pt-5 sm:px-7 sm:pb-7 sm:pt-[26px]">
              <h3 className="font-display text-[20px] font-extrabold tracking-[-0.02em]">Nothing on the shelves yet</h3>
              <p className="mb-[18px] mt-2.5 text-sm leading-[1.6] text-ink-soft">
                Anyone can list a canvas here from its Share menu — people preview it and copy it into their own
                account, and the original stays private. Be the first.
              </p>
              <Button variant="primary" onClick={() => navigate('/')}>
                Pick a canvas to publish
              </Button>
            </Card>
          ) : (
            <>
              {items !== null && (query.trim() || shelf !== 'all') && (
                <div className="mt-[18px] text-xs text-ink-faint">
                  {visible.length} of {items.length}
                </div>
              )}
              {items !== null && visible.length === 0 ? (
                <p className="mt-7 text-[13.5px] text-ink-soft">Nothing matches — try a different search or shelf.</p>
              ) : (
                <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-3.5 xs:grid-cols-[repeat(auto-fill,minmax(250px,1fr))] md:gap-4">
                  {items === null &&
                    [0, 1, 2, 3].map((i) => <Skeleton key={i} index={i} className={cn(cardCls, 'min-h-[260px]')} />)}
                  {visible.map((item) => (
                    <GalleryCard
                      key={item.id}
                      item={item}
                      copying={copyingId === item.id}
                      onOpen={() => setOpen(item)}
                      onCopy={() => copy(item)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </DashContent>
      </DashMain>

      {open && (
        <DesignModal
          key={open.id}
          item={open}
          copying={copyingId === open.id}
          onCopy={() => copy(open)}
          onClose={() => setOpen(null)}
        />
      )}
      {toast && <Toast>{toast}</Toast>}
    </DashLayout>
  )
}

function GalleryCard({
  item,
  copying,
  onOpen,
  onCopy,
}: {
  item: CommunityItem
  copying: boolean
  onOpen: () => void
  onCopy: () => void
}) {
  const cover = item.frames[0]
  return (
    <div className={cardCls}>
      <button
        className="block w-full border-0 bg-transparent text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
        onClick={onOpen}
      >
        <div className="relative grid aspect-[16/10] place-items-center overflow-hidden border-b border-line-soft [background:radial-gradient(circle,var(--dot)_1px,transparent_1px)_0_0/18px_18px,var(--paper-deep)]">
          {cover ? <FrameImage frameId={cover.id} /> : <span className="text-[12px] text-ink-faint">no preview</span>}
          {item.frames.length > 1 && (
            <Badge className="absolute left-2 top-2 bg-surface/90">{item.frames.length} frames</Badge>
          )}
        </div>
        <div className="px-3 pb-3 pt-2.5">
          <div className="truncate font-display text-[13.5px] font-semibold">{item.name}</div>
          {item.description && (
            <p className="mt-1 line-clamp-2 text-[12px] leading-[1.45] text-ink-soft">{item.description}</p>
          )}
          <div className="mt-[7px] flex items-center gap-1.5 text-[11.5px] text-ink-faint">
            <span className="truncate">by {item.authorName}</span>
            <span className="opacity-60">·</span>
            <span className="flex-none">
              {item.copyCount} {item.copyCount === 1 ? 'copy' : 'copies'}
            </span>
          </div>
        </div>
      </button>
      <Button
        size="sm"
        variant="primary"
        disabled={copying}
        onClick={onCopy}
        className="absolute right-2 top-2 opacity-100 shadow-pop md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
      >
        <CopyIcon className="size-3.5" /> {copying ? 'Copying…' : 'Use this'}
      </Button>
    </div>
  )
}

/** One listing up close: every frame the owner published, at a glance,
 *  and the one action the gallery offers. */
function DesignModal({
  item,
  copying,
  onCopy,
  onClose,
}: {
  item: CommunityItem
  copying: boolean
  onCopy: () => void
  onClose: () => void
}) {
  return (
    <Modal size="xl" onClose={onClose}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <ModalEyebrow>{COMMUNITY_CATEGORY_LABELS[item.category]}</ModalEyebrow>
          <ModalTitle className="mt-1.5 truncate">{item.name}</ModalTitle>
          <p className="mt-1 text-[12.5px] text-ink-faint">
            by {item.authorName} · published {timeAgo(item.publishedAt)} · {item.copyCount}{' '}
            {item.copyCount === 1 ? 'copy' : 'copies'}
          </p>
        </div>
        <Button variant="ghost" size="icon" className="size-10 flex-none" aria-label="Close" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      {item.description && <p className="mt-3 text-sm leading-[1.6] text-ink-soft">{item.description}</p>}
      <div className="-mx-5 mt-4 flex gap-3 overflow-x-auto px-5 pb-2 sm:-mx-7 sm:px-7">
        {item.frames.map((frame) => (
          <figure key={frame.id} className="flex-none">
            {/* one shared height so mixed artboards read as a row, not a
                staircase. The box takes the shape of the image it holds: the
                preview render clips tall frames at PREVIEW_MAX_HEIGHT, so a
                6000px landing page arrives as a landscape shot of its top —
                sizing to the frame's real height would squeeze that into a
                portrait sliver and crop the sides away. */}
            <div
              className="h-[300px] max-w-[min(520px,80vw)] overflow-hidden rounded-[10px] border border-line bg-paper-deep"
              style={{ aspectRatio: `${frame.width} / ${Math.min(frame.height, PREVIEW_MAX_HEIGHT)}` }}
            >
              <FrameImage frameId={frame.id} />
            </div>
            <figcaption className="mt-1.5 truncate text-[11.5px] text-ink-faint">
              {frame.name} · {Math.round(frame.width)}×{Math.round(frame.height)}
            </figcaption>
          </figure>
        ))}
      </div>
      <div className="mt-4 flex flex-col items-stretch gap-2.5 border-t border-line-soft pt-4 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-xs text-ink-faint">
          Copies land in your canvases as a private copy — edit freely, the original is untouched.
        </span>
        <Button variant="primary" className="justify-center" disabled={copying} onClick={onCopy}>
          <CopyIcon className="size-4" /> {copying ? 'Copying…' : 'Copy to my canvases'}
        </Button>
      </div>
    </Modal>
  )
}

/** A published frame through the public image pipeline. The frame id is
 *  all the gallery holds; a render that fails says so instead of leaving a
 *  blank tile that looks like an empty design. */
function FrameImage({ frameId }: { frameId: string }) {
  const [failed, setFailed] = useState(false)
  if (failed)
    return <span className="grid h-full w-full place-items-center text-[12px] text-ink-faint">preview unavailable</span>
  return (
    <img
      src={`/i/${frameId}.jpg?preview`}
      alt=""
      loading="lazy"
      className="h-full w-full object-cover object-top"
      onError={() => setFailed(true)}
    />
  )
}
