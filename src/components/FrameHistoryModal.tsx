import { useEffect, useState } from 'react'
import type { Frame, FrameVersion, FrameVersionInfo } from '../../shared/types'
import { api, errorMessage } from '../lib/api'
import { recordUpdate } from '../lib/history'
import { canEditOpenCanvas, useStore } from '../lib/store'
import { timeAgo } from '../lib/time'
import { AgentIcon } from './AgentIcon'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { ListMeta, ListRow, ListSummary, ListTitle } from './ui/list'
import { Modal, ModalActions, ModalLede, ModalSpacer, ModalTitle } from './ui/modal'

/* a version is shown at its own size, scaled to fit the modal */
const PREVIEW_W = 696

type Shown = Pick<FrameVersion, 'html' | 'width' | 'height'>

/** A frame's design history: every state a later edit replaced, newest
 *  first, with the live design on top. Pick one to preview it at its own
 *  size; Restore puts it back (HTML and size) through the server, so the
 *  whole room sees it land. The server files the current design as a version
 *  first, so a restore can itself be undone from here — and ⌘Z reverts it
 *  locally like any other edit. */
export function FrameHistoryModal({ frame, onClose }: { frame: Frame; onClose: () => void }) {
  /* the live frame: the prop is a snapshot from the menu that opened us */
  const live = useStore((s) => s.canvas?.frames.find((f) => f.id === frame.id)) ?? frame
  /* a view or comment link may browse the history, not restore from it */
  const readOnly = useStore((s) => !canEditOpenCanvas(s))
  const [versions, setVersions] = useState<FrameVersionInfo[] | null>(null)
  const [selected, setSelected] = useState<FrameVersionInfo | 'current' | null>(null)
  const [loaded, setLoaded] = useState<FrameVersion | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    api
      .frameVersions(frame.id)
      .then((list) => alive && setVersions(list))
      .catch((err) => alive && setError(errorMessage(err, 'Couldn’t load the version history')))
    return () => {
      alive = false
    }
  }, [frame.id])

  useEffect(() => {
    if (!selected || selected === 'current') return
    let alive = true
    api
      .frameVersion(frame.id, selected.id)
      .then((version) => alive && setLoaded(version))
      .catch((err) => alive && setError(errorMessage(err, 'Couldn’t load this version')))
    return () => {
      alive = false
    }
  }, [frame.id, selected])

  async function restore(version: FrameVersionInfo) {
    setBusy(true)
    setError(null)
    try {
      /* the undo copy is the server's, not this client's: during an agent's
         reveal the local frame holds only the HTML shown so far */
      const { frame: after, replaced } = await api.restoreFrameVersion(frame.id, version.id)
      recordUpdate(frame.id, replaced, { html: after.html, width: after.width, height: after.height })
      useStore.getState().upsertFrame(after)
      useStore.getState().pushNotice(`Restored “${after.name}” to the version from ${timeAgo(version.savedAt)}`)
      onClose()
    } catch (err) {
      setError(errorMessage(err, 'Couldn’t restore this version'))
      setBusy(false)
    }
  }

  /* who wrote the picked state, and when — known from the listing before its HTML loads */
  const picked =
    selected === 'current'
      ? { label: 'current design · last edit by', name: live.updatedBy, kind: undefined, at: live.updatedAt }
      : selected
        ? { label: 'by', name: selected.savedBy, kind: selected.savedByKind, at: selected.savedAt }
        : null
  const shown: Shown | null =
    selected === 'current'
      ? { html: live.html, width: live.width, height: live.height }
      : selected && loaded?.id === selected.id
        ? loaded
        : null

  return (
    <Modal size="xl" onClose={onClose}>
      <div className="flex flex-wrap items-baseline gap-2.5">
        <ModalTitle className="break-words">“{live.name}” — version history</ModalTitle>
        {shown && (
          <Badge tone="outline" className="rounded-full px-2 py-px">
            {Math.round(shown.width)}×{Math.round(shown.height)}
          </Badge>
        )}
      </div>
      {error && <p className="mt-2.5 text-[13px] text-accent-ink">{error}</p>}
      {picked ? (
        <>
          <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-ink-faint">
            {picked.label} <Author name={picked.name} kind={picked.kind} /> · {new Date(picked.at).toLocaleString()}
          </div>
          {shown ? <VersionPreview title={live.name} version={shown} /> : <ModalLede>Loading this version…</ModalLede>}
          <ModalActions>
            <Button variant="ghost" disabled={busy} onClick={() => setSelected(null)}>
              Back
            </Button>
            <ModalSpacer />
            {selected && selected !== 'current' && !readOnly && (
              <Button variant="primary" disabled={busy || !shown} onClick={() => void restore(selected)}>
                {busy ? 'Restoring…' : 'Restore this version'}
              </Button>
            )}
          </ModalActions>
        </>
      ) : (
        <>
          <ModalLede>
            Every design a redesign, stream or restore replaced is kept here. Pick one to preview it, then restore it
            for everyone on the canvas.
          </ModalLede>
          <div className="mt-3.5 overflow-hidden rounded-[12px] border border-line bg-surface">
            <ListRow className="border-b-0" onClick={() => setSelected('current')}>
              <ListTitle>Current</ListTitle>
              <ListSummary>
                {Math.round(live.width)}×{Math.round(live.height)} · {kb(live.html.length)}
              </ListSummary>
              <ListMeta className="flex items-center gap-1">
                <Author name={live.updatedBy} /> · {timeAgo(live.updatedAt)}
              </ListMeta>
            </ListRow>
            {versions === null && !error && <ModalLede className="px-4 pb-3">Loading…</ModalLede>}
            {versions?.length === 0 && (
              <ModalLede className="px-4 pb-3">
                No earlier versions yet — they appear once a design is replaced.
              </ModalLede>
            )}
            {(versions ?? []).map((v, i) => (
              <ListRow key={v.id} className="border-b-0 border-t border-line-soft" onClick={() => setSelected(v)}>
                <ListTitle>v{(versions?.length ?? 0) - i}</ListTitle>
                <ListSummary>
                  {Math.round(v.width)}×{Math.round(v.height)} · {kb(v.htmlBytes)}
                </ListSummary>
                <ListMeta className="flex items-center gap-1">
                  <Author name={v.savedBy} kind={v.savedByKind} /> · {timeAgo(v.savedAt)}
                </ListMeta>
              </ListRow>
            ))}
          </div>
          <ModalActions>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </ModalActions>
        </>
      )}
    </Modal>
  )
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`
}

function Author({ name, kind }: { name: string; kind?: FrameVersion['savedByKind'] }) {
  return (
    <span className="inline-flex items-center gap-1">
      {kind === 'agent' && <AgentIcon name={name} size={11} />}
      {name}
    </span>
  )
}

/** The version's HTML at its own size, scaled to fit; no scripts run. */
function VersionPreview({ title, version }: { title: string; version: Shown }) {
  const w = Math.min(PREVIEW_W, window.innerWidth - 110)
  const scale = Math.min(1, w / version.width)
  return (
    <div
      className="mt-3.5 overflow-auto rounded-[12px] border border-line bg-surface"
      style={{ height: Math.min(version.height * scale, window.innerHeight * 0.55) }}
    >
      <iframe
        className="pointer-events-none origin-top-left border-0"
        title={title}
        srcDoc={version.html}
        sandbox=""
        tabIndex={-1}
        style={{ width: version.width, height: version.height, transform: `scale(${scale})` }}
      />
    </div>
  )
}
