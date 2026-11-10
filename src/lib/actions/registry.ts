/* Every command the canvas editor offers, in one list: the keyboard handler,
   the ⌘K palette, the main menu and the shortcuts sheet all read it, so a
   command, its name and its chord are written once. The canvas page lends
   the registry what only it holds (its modals and panels) as the host. */

import type { PlainMessageKey } from '../i18n'
import { useStore } from '../store'
import { currentPageCanvas } from '../pages'
import { readingOrder } from '../../../shared/frameOrder'
import { redo, undo } from '../history'
import { runViewCommand } from '../viewMenu'
import { downloadFramesPdf } from '../frameExport'
import { duplicateFrames, hasFrameClip, pasteFramesOver, replaceFramesWithClip } from '../frameClipboard'
import { hasElementClip, pasteLayer, replaceWithClip } from '../elementClipboard'
import {
  deleteSelection,
  duplicateLayers,
  formatSelectionText,
  toggleLockSelection,
  toggleSelectionHidden,
} from '../layerEdits'
import { reorderSelection, selectAll } from '../selectionKeys'
import type { Chord } from './chords'
import { IS_MAC, matchesChord } from './chords'
import {
  addAutoLayout,
  align,
  arrangeCount,
  canEdit,
  canPickColor,
  copyProperties,
  distributeEdgesOf,
  distributeSpacingOf,
  flip,
  fontSizeBy,
  groupSelection,
  hasInnerPick,
  hasStyleClip,
  hideOthers,
  pack,
  pasteProperties,
  pickColor,
  pickedLayers,
  removeAutoLayout,
  removeFill,
  rotateBy,
  roundFramesToPixel,
  selectedFrames,
  selectInverse,
  selectMatching,
  stepFrame,
  stepPage,
  textAlign,
  textCase,
  tidy,
  ungroupSelection,
} from './edits'

/** What the canvas page lends the registry: its own modals and panels. */
export interface ActionHost {
  canvasId: string
  /** a person looking at the canvas, not an editor's account */
  guest: boolean
  presenting: boolean
  /** ⌘. has something to hide here (the canvas, not the board) */
  hideUiActive: boolean
  agentsOpen: boolean
  openPalette(): void
  openAgent(): void
  openShortcuts(): void
  /** leave the canvas for the list of canvases */
  goToFiles(): void
  openDocs(): void
  contactSupport(): void
  openFind(mode: 'find' | 'replace'): void
  findStep(dir: 1 | -1): void
  openExport(): void
  openImport(): void
  openVersionHistory(): void
  openLink(): void
  placeImage(): void
  newCanvas(): void
  duplicateCanvas(): void
  present(): void
  toggleHideUi(): void
  toggleAgents(): void
}

let host: ActionHost | null = null
const hostListeners = new Set<() => void>()

/** The canvas page installs itself as the host while it is mounted. */
export function setActionHost(next: ActionHost | null) {
  host = next
  for (const listener of hostListeners) listener()
}

/** Called whenever the host is installed, replaced or removed (the desktop
 *  menu bar re-reads what is enabled then); returns the unsubscribe. */
export function onActionHostChange(listener: () => void): () => void {
  hostListeners.add(listener)
  return () => hostListeners.delete(listener)
}

export type MenuId = 'general' | 'file' | 'edit' | 'view' | 'object' | 'text' | 'arrange' | 'help'

export const MENUS: { id: Exclude<MenuId, 'general'>; label: PlainMessageKey }[] = [
  { id: 'file', label: 'actions.menuFile' },
  { id: 'edit', label: 'actions.menuEdit' },
  { id: 'view', label: 'actions.menuView' },
  { id: 'object', label: 'actions.menuObject' },
  { id: 'text', label: 'actions.menuText' },
  { id: 'arrange', label: 'actions.menuArrange' },
  { id: 'help', label: 'actions.menuHelp' },
]

export interface CanvasAction {
  id: string
  label: PlainMessageKey
  menu: MenuId
  /** rows sharing a section number sit between the same separators */
  section: number
  /** the first chord bound on this platform is the one menus show */
  keys?: readonly Chord[]
  /** changes the canvas: only an editor may run it */
  edit?: boolean
  /** the chords are shown, but another handler owns them (⌫ and Esc, which
   *  the canvas page claims with rules of their own) */
  hintOnly?: boolean
  enabled?: () => boolean
  /** a toggle's state, for the check a menu row wears */
  checked?: () => boolean
  /** false when there was nothing to act on: the key is left to the browser */
  run: () => boolean | void
}

const store = () => useStore.getState()
const h = () => host
const hasSelection = () => store().selectedIds.length > 0 || !!store().selectedElement
const picked = () => !!pickedLayers()
const editing = () => canEdit()
const pasteable = () => hasFrameClip() || hasElementClip()

/* the frames a PDF export takes: the selection, else the whole page, in reading order */
function pdfFrames() {
  const selected = selectedFrames()
  return selected.length ? selected : readingOrder(currentPageCanvas()?.frames ?? [])
}

function pasteOver(): boolean {
  const p = pickedLayers()
  if (p && hasElementClip()) return pasteLayer(p.frame, p.selectors[p.selectors.length - 1] ?? null)
  const frames = selectedFrames()
  const canvasId = h()?.canvasId
  return !!canvasId && hasFrameClip() && pasteFramesOver(canvasId, frames)
}

function pasteReplace(): boolean {
  const p = pickedLayers()
  if (p && !p.standalone && hasElementClip()) return replaceWithClip(p.frame, p.selectors)
  const frames = selectedFrames()
  const canvasId = h()?.canvasId
  return !!canvasId && hasFrameClip() && frames.length > 0 && replaceFramesWithClip(canvasId, frames)
}

function duplicate(): boolean {
  const p = pickedLayers()
  if (p) {
    duplicateLayers(p.frame, p.selectors)
    return true
  }
  const frames = selectedFrames()
  if (!frames.length) return false
  duplicateFrames(frames)
  return true
}

const mod = (key: string, extra: Partial<Chord> = {}): Chord => ({ key, mod: true, ...extra })
const code = (c: string, extra: Partial<Chord> = {}): Chord => ({ code: c, ...extra })

export const ACTIONS: readonly CanvasAction[] = [
  /* ---- the way out, the palette's own line and the agent ---- */
  {
    id: 'go-to-files',
    label: 'actions.goToFiles',
    menu: 'general',
    section: 0,
    enabled: () => !h()?.guest,
    run: () => h()?.goToFiles(),
  },
  {
    id: 'palette',
    label: 'actions.palette',
    menu: 'general',
    section: 0,
    keys: [mod('k', { global: true })],
    run: () => h()?.openPalette(),
  },
  {
    id: 'ask-agent',
    label: 'actions.askAgent',
    menu: 'general',
    section: 0,
    keys: [mod('/', { global: true }), { key: '/' }],
    enabled: () => !h()?.guest && editing(),
    run: () => h()?.openAgent(),
  },

  /* ---- File ---- */
  {
    id: 'new-canvas',
    label: 'actions.newCanvas',
    menu: 'file',
    section: 0,
    enabled: () => !h()?.guest,
    run: () => h()?.newCanvas(),
  },
  {
    id: 'duplicate-canvas',
    label: 'actions.duplicateCanvas',
    menu: 'file',
    section: 0,
    enabled: () => !h()?.guest,
    run: () => h()?.duplicateCanvas(),
  },
  {
    id: 'place-image',
    label: 'actions.placeImage',
    menu: 'file',
    section: 1,
    keys: [mod('k', { shift: true })],
    edit: true,
    run: () => h()?.placeImage(),
  },
  {
    id: 'import',
    label: 'actions.import',
    menu: 'file',
    section: 1,
    edit: true,
    enabled: () => !h()?.guest,
    run: () => h()?.openImport(),
  },
  {
    id: 'version-history',
    label: 'actions.versionHistory',
    menu: 'file',
    section: 2,
    enabled: () => store().selectedIds.length === 1,
    run: () => h()?.openVersionHistory(),
  },
  {
    id: 'export',
    label: 'actions.export',
    menu: 'file',
    section: 3,
    keys: [mod('e', { shift: true })],
    run: () => h()?.openExport(),
  },
  {
    id: 'export-pdf',
    label: 'actions.exportPdf',
    menu: 'file',
    section: 3,
    enabled: () => pdfFrames().length > 0,
    run: () => {
      const canvasId = h()?.canvasId
      if (canvasId) void downloadFramesPdf(canvasId, pdfFrames())
    },
  },

  /* ---- Edit ---- */
  { id: 'undo', label: 'actions.undo', menu: 'edit', section: 0, keys: [mod('z')], edit: true, run: () => void undo() },
  {
    id: 'redo',
    label: 'actions.redo',
    menu: 'edit',
    section: 0,
    keys: [mod('z', { shift: true }), mod('y', { notMac: true })],
    edit: true,
    run: () => void redo(),
  },
  {
    id: 'paste-over',
    label: 'actions.pasteOver',
    menu: 'edit',
    section: 1,
    keys: [mod('v', { shift: true })],
    edit: true,
    enabled: () => pasteable() && hasSelection(),
    run: pasteOver,
  },
  {
    id: 'paste-replace',
    label: 'actions.pasteReplace',
    menu: 'edit',
    section: 1,
    keys: [mod('r', { shift: true })],
    edit: true,
    enabled: () => pasteable() && hasSelection(),
    run: pasteReplace,
  },
  {
    id: 'duplicate',
    label: 'actions.duplicate',
    menu: 'edit',
    section: 1,
    keys: [mod('d')],
    edit: true,
    enabled: hasSelection,
    run: duplicate,
  },
  {
    id: 'delete',
    label: 'actions.delete',
    menu: 'edit',
    section: 1,
    keys: [{ key: 'Backspace' }, { key: 'Delete' }],
    hintOnly: true,
    edit: true,
    enabled: hasSelection,
    run: () => deleteSelection(),
  },
  { id: 'find', label: 'actions.find', menu: 'edit', section: 2, keys: [mod('f')], run: () => h()?.openFind('find') },
  { id: 'find-next', label: 'actions.findNext', menu: 'edit', section: 2, run: () => h()?.findStep(1) },
  { id: 'find-previous', label: 'actions.findPrevious', menu: 'edit', section: 2, run: () => h()?.findStep(-1) },
  {
    id: 'find-replace',
    label: 'actions.findReplace',
    menu: 'edit',
    section: 2,
    keys: [mod('f', { alt: true, code: 'KeyF' })],
    edit: true,
    run: () => h()?.openFind('replace'),
  },
  {
    id: 'copy-properties',
    label: 'actions.copyProperties',
    menu: 'edit',
    section: 3,
    keys: [mod('c', { alt: true, code: 'KeyC' })],
    enabled: picked,
    run: () => void copyProperties(),
  },
  {
    id: 'paste-properties',
    label: 'actions.pasteProperties',
    menu: 'edit',
    section: 3,
    keys: [mod('v', { alt: true, code: 'KeyV' })],
    edit: true,
    enabled: () => picked() && hasStyleClip(),
    run: pasteProperties,
  },
  {
    id: 'pick-color',
    label: 'actions.pickColor',
    menu: 'edit',
    section: 4,
    keys: [{ key: 'c', ctrl: true, macOnly: true }],
    enabled: canPickColor,
    run: () => void pickColor(),
  },
  {
    id: 'select-all',
    label: 'actions.selectAll',
    menu: 'edit',
    section: 5,
    keys: [mod('a')],
    /* claimed even when everything is already selected: left to the browser,
       a second ⌘A would select the editor's own text and controls */
    run: () => void selectAll(),
  },
  {
    id: 'select-none',
    label: 'actions.selectNone',
    menu: 'edit',
    section: 5,
    keys: [{ key: 'Escape' }],
    hintOnly: true,
    enabled: hasSelection,
    run: () => {
      store().select(null)
    },
  },
  {
    id: 'select-inverse',
    label: 'actions.selectInverse',
    menu: 'edit',
    section: 5,
    keys: [mod('a', { shift: true })],
    run: selectInverse,
  },
  {
    id: 'select-matching',
    label: 'actions.selectMatching',
    menu: 'edit',
    section: 5,
    keys: [mod('a', { alt: true, code: 'KeyA' })],
    enabled: hasInnerPick,
    run: selectMatching,
  },

  /* ---- View ---- */
  {
    id: 'rulers',
    label: 'actions.rulers',
    menu: 'view',
    section: 0,
    keys: [{ key: 'r', shift: true }],
    checked: () => store().rulers,
    run: () => store().toggleRulers(),
  },
  {
    id: 'pixel-grid',
    label: 'actions.pixelGrid',
    menu: 'view',
    section: 0,
    keys: [{ code: 'Quote', shift: true }],
    checked: () => store().viewOptions.pixelGrid,
    run: () => store().toggleViewOption('pixelGrid'),
  },
  {
    id: 'comments',
    label: 'actions.comments',
    menu: 'view',
    section: 0,
    keys: [{ key: 'c', shift: true }],
    checked: () => store().viewOptions.comments,
    run: () => store().toggleViewOption('comments'),
  },
  {
    id: 'outlines',
    label: 'actions.outlines',
    menu: 'view',
    section: 0,
    keys: [mod('y', { macOnly: true })],
    checked: () => store().outlines,
    run: () => store().toggleOutlines(),
  },
  {
    id: 'ui',
    label: 'actions.showUi',
    menu: 'view',
    section: 1,
    keys: [mod('.'), mod('\\', { code: 'Backslash' })],
    enabled: () => !!h()?.hideUiActive,
    checked: () => !store().uiHidden,
    run: () => h()?.toggleHideUi(),
  },
  {
    id: 'cursors',
    label: 'actions.cursors',
    menu: 'view',
    section: 1,
    keys: [mod('\\', { alt: true, code: 'Backslash' })],
    checked: () => store().viewOptions.cursors,
    run: () => store().toggleViewOption('cursors'),
  },
  {
    id: 'layers-panel',
    label: 'actions.layersPanel',
    menu: 'view',
    section: 1,
    checked: () => store().layersOpen,
    run: () => store().setLayersOpen(!store().layersOpen),
  },
  {
    id: 'agents-panel',
    label: 'actions.agentsPanel',
    menu: 'view',
    section: 1,
    enabled: () => !h()?.guest,
    checked: () => !!h()?.agentsOpen,
    run: () => h()?.toggleAgents(),
  },
  {
    id: 'zoom-in',
    label: 'actions.zoomIn',
    menu: 'view',
    section: 2,
    keys: [mod('='), mod('+', { shift: true }), mod('+')],
    run: () => runViewCommand('zoom-in'),
  },
  {
    id: 'zoom-out',
    label: 'actions.zoomOut',
    menu: 'view',
    section: 2,
    keys: [mod('-')],
    run: () => runViewCommand('zoom-out'),
  },
  {
    id: 'zoom-reset',
    label: 'actions.zoom100',
    menu: 'view',
    section: 2,
    keys: [mod('0')],
    run: () => runViewCommand('zoom-reset'),
  },
  {
    id: 'zoom-fit',
    label: 'actions.zoomFit',
    menu: 'view',
    section: 2,
    keys: [code('Digit1', { shift: true })],
    run: () => runViewCommand('zoom-fit'),
  },
  {
    id: 'zoom-selection',
    label: 'actions.zoomSelection',
    menu: 'view',
    section: 2,
    keys: [code('Digit2', { shift: true })],
    enabled: hasSelection,
    run: () => runViewCommand('zoom-selection'),
  },
  {
    id: 'previous-page',
    label: 'actions.previousPage',
    menu: 'view',
    section: 3,
    keys: [{ key: 'PageUp' }],
    run: () => stepPage(-1),
  },
  {
    id: 'next-page',
    label: 'actions.nextPage',
    menu: 'view',
    section: 3,
    keys: [{ key: 'PageDown' }],
    run: () => stepPage(1),
  },
  {
    id: 'zoom-previous-frame',
    label: 'actions.zoomPreviousFrame',
    menu: 'view',
    section: 3,
    keys: [{ key: 'n', shift: true }],
    run: () => stepFrame(-1, true),
  },
  {
    id: 'zoom-next-frame',
    label: 'actions.zoomNextFrame',
    menu: 'view',
    section: 3,
    keys: [{ key: 'n' }],
    run: () => stepFrame(1, true),
  },
  {
    id: 'find-previous-frame',
    label: 'actions.findPreviousFrame',
    menu: 'view',
    section: 3,
    keys: [{ key: 'Home' }],
    run: () => stepFrame(-1, false),
  },
  {
    id: 'find-next-frame',
    label: 'actions.findNextFrame',
    menu: 'view',
    section: 3,
    keys: [{ key: 'End' }],
    run: () => stepFrame(1, false),
  },
  {
    id: 'present',
    label: 'actions.present',
    menu: 'view',
    section: 4,
    keys: [mod('Enter', { alt: true })],
    run: () => h()?.present(),
  },

  /* ---- Object ---- */
  {
    id: 'frame-selection',
    label: 'actions.frameSelection',
    menu: 'object',
    section: 0,
    keys: [mod('g', { alt: true, code: 'KeyG' })],
    edit: true,
    enabled: hasInnerPick,
    run: () => groupSelection('frame'),
  },
  {
    id: 'group',
    label: 'actions.group',
    menu: 'object',
    section: 0,
    keys: [mod('g')],
    edit: true,
    enabled: hasInnerPick,
    run: () => groupSelection('group'),
  },
  {
    id: 'ungroup',
    label: 'actions.ungroup',
    menu: 'object',
    section: 0,
    keys: [mod('g', { shift: true }), mod('Backspace')],
    edit: true,
    enabled: hasInnerPick,
    run: ungroupSelection,
  },
  {
    id: 'auto-layout',
    label: 'actions.addAutoLayout',
    menu: 'object',
    section: 1,
    keys: [{ key: 'a', shift: true }],
    edit: true,
    enabled: hasInnerPick,
    run: () => void addAutoLayout(),
  },
  {
    id: 'remove-auto-layout',
    label: 'actions.removeAutoLayout',
    menu: 'object',
    section: 1,
    keys: [{ code: 'KeyA', alt: true, shift: true }],
    edit: true,
    enabled: hasInnerPick,
    run: removeAutoLayout,
  },
  {
    id: 'bring-to-front',
    label: 'actions.bringToFront',
    menu: 'object',
    section: 2,
    keys: [code('BracketRight'), mod(']', { alt: true, code: 'BracketRight' })],
    edit: true,
    enabled: hasSelection,
    run: () => reorderSelection('front'),
  },
  {
    id: 'bring-forward',
    label: 'actions.bringForward',
    menu: 'object',
    section: 2,
    keys: [mod(']', { code: 'BracketRight' })],
    edit: true,
    enabled: hasSelection,
    run: () => reorderSelection('forward'),
  },
  {
    id: 'send-backward',
    label: 'actions.sendBackward',
    menu: 'object',
    section: 2,
    keys: [mod('[', { code: 'BracketLeft' })],
    edit: true,
    enabled: hasSelection,
    run: () => reorderSelection('backward'),
  },
  {
    id: 'send-to-back',
    label: 'actions.sendToBack',
    menu: 'object',
    section: 2,
    keys: [code('BracketLeft'), mod('[', { alt: true, code: 'BracketLeft' })],
    edit: true,
    enabled: hasSelection,
    run: () => reorderSelection('back'),
  },
  {
    id: 'flip-horizontal',
    label: 'actions.flipHorizontal',
    menu: 'object',
    section: 3,
    keys: [{ key: 'h', shift: true }],
    edit: true,
    enabled: picked,
    run: () => flip('x'),
  },
  {
    id: 'flip-vertical',
    label: 'actions.flipVertical',
    menu: 'object',
    section: 3,
    keys: [{ key: 'v', shift: true }],
    edit: true,
    enabled: picked,
    run: () => flip('y'),
  },
  {
    id: 'rotate-180',
    label: 'actions.rotate180',
    menu: 'object',
    section: 3,
    edit: true,
    enabled: hasSelection,
    run: () => rotateBy(180),
  },
  {
    id: 'rotate-left',
    label: 'actions.rotateLeft',
    menu: 'object',
    section: 3,
    edit: true,
    enabled: hasSelection,
    run: () => rotateBy(-90),
  },
  {
    id: 'rotate-right',
    label: 'actions.rotateRight',
    menu: 'object',
    section: 3,
    edit: true,
    enabled: hasSelection,
    run: () => rotateBy(90),
  },
  {
    id: 'toggle-hidden',
    label: 'actions.showHide',
    menu: 'object',
    section: 4,
    keys: [mod('h', { shift: true })],
    edit: true,
    enabled: hasSelection,
    run: () => toggleSelectionHidden(),
  },
  {
    id: 'toggle-locked',
    label: 'actions.lockUnlock',
    menu: 'object',
    section: 4,
    keys: [mod('l', { shift: true })],
    edit: true,
    enabled: hasSelection,
    run: () => toggleLockSelection(),
  },
  {
    id: 'hide-others',
    label: 'actions.hideOthers',
    menu: 'object',
    section: 4,
    edit: true,
    enabled: hasSelection,
    run: hideOthers,
  },
  {
    id: 'collapse-layers',
    label: 'actions.collapseLayers',
    menu: 'object',
    section: 4,
    keys: [{ code: 'KeyL', alt: true }],
    run: () => store().requestCollapseLayers(),
  },
  {
    id: 'remove-fill',
    label: 'actions.removeFill',
    menu: 'object',
    section: 5,
    keys: [{ code: 'Slash', alt: true }],
    edit: true,
    enabled: picked,
    run: removeFill,
  },

  /* ---- Text ---- */
  {
    id: 'bold',
    label: 'actions.bold',
    menu: 'text',
    section: 0,
    keys: [mod('b')],
    edit: true,
    enabled: picked,
    run: () => formatSelectionText('bold'),
  },
  {
    id: 'italic',
    label: 'actions.italic',
    menu: 'text',
    section: 0,
    keys: [mod('i')],
    edit: true,
    enabled: picked,
    run: () => formatSelectionText('italic'),
  },
  {
    id: 'underline',
    label: 'actions.underline',
    menu: 'text',
    section: 0,
    keys: [mod('u')],
    edit: true,
    enabled: picked,
    run: () => formatSelectionText('underline'),
  },
  {
    id: 'strikethrough',
    label: 'actions.strikethrough',
    menu: 'text',
    section: 0,
    keys: [mod('x', { shift: true })],
    edit: true,
    enabled: picked,
    run: () => formatSelectionText('strikeThrough'),
  },
  {
    id: 'link',
    label: 'actions.createLink',
    menu: 'text',
    section: 0,
    keys: [mod('u', { shift: true })],
    edit: true,
    enabled: hasInnerPick,
    run: () => h()?.openLink(),
  },
  {
    id: 'bulleted-list',
    label: 'actions.bulletedList',
    menu: 'text',
    section: 1,
    keys: [mod('8', { shift: true, code: 'Digit8' })],
    edit: true,
    enabled: picked,
    run: () => formatSelectionText('insertUnorderedList'),
  },
  {
    id: 'numbered-list',
    label: 'actions.numberedList',
    menu: 'text',
    section: 1,
    keys: [mod('7', { shift: true, code: 'Digit7' })],
    edit: true,
    enabled: picked,
    run: () => formatSelectionText('insertOrderedList'),
  },
  {
    id: 'text-left',
    label: 'actions.textAlignLeft',
    menu: 'text',
    section: 2,
    keys: [mod('l', { alt: true, code: 'KeyL' })],
    edit: true,
    enabled: picked,
    run: () => textAlign('left'),
  },
  {
    id: 'text-center',
    label: 'actions.textAlignCenter',
    menu: 'text',
    section: 2,
    keys: [mod('t', { alt: true, code: 'KeyT' })],
    edit: true,
    enabled: picked,
    run: () => textAlign('center'),
  },
  {
    id: 'text-right',
    label: 'actions.textAlignRight',
    menu: 'text',
    section: 2,
    keys: [mod('r', { alt: true, code: 'KeyR' })],
    edit: true,
    enabled: picked,
    run: () => textAlign('right'),
  },
  {
    id: 'text-justify',
    label: 'actions.textAlignJustify',
    menu: 'text',
    section: 2,
    keys: [mod('j', { alt: true, code: 'KeyJ' })],
    edit: true,
    enabled: picked,
    run: () => textAlign('justify'),
  },
  {
    id: 'font-bigger',
    label: 'actions.fontSizeUp',
    menu: 'text',
    section: 3,
    keys: [mod('>', { shift: true, code: 'Period' })],
    edit: true,
    enabled: picked,
    run: () => fontSizeBy(1),
  },
  {
    id: 'font-smaller',
    label: 'actions.fontSizeDown',
    menu: 'text',
    section: 3,
    keys: [mod('<', { shift: true, code: 'Comma' })],
    edit: true,
    enabled: picked,
    run: () => fontSizeBy(-1),
  },
  {
    id: 'case-upper',
    label: 'actions.caseUpper',
    menu: 'text',
    section: 4,
    edit: true,
    enabled: picked,
    run: () => textCase('uppercase'),
  },
  {
    id: 'case-lower',
    label: 'actions.caseLower',
    menu: 'text',
    section: 4,
    edit: true,
    enabled: picked,
    run: () => textCase('lowercase'),
  },
  {
    id: 'case-title',
    label: 'actions.caseTitle',
    menu: 'text',
    section: 4,
    edit: true,
    enabled: picked,
    run: () => textCase('capitalize'),
  },
  {
    id: 'case-none',
    label: 'actions.caseNone',
    menu: 'text',
    section: 4,
    edit: true,
    enabled: picked,
    run: () => textCase('none'),
  },

  /* ---- Arrange ---- */
  {
    id: 'round-to-pixel',
    label: 'actions.roundToPixel',
    menu: 'arrange',
    section: 0,
    edit: true,
    enabled: () => selectedFrames().length > 0,
    run: roundFramesToPixel,
  },
  ...(
    [
      ['align-left', 'actions.alignLeft', 'KeyA', 'left'],
      ['align-hcenter', 'actions.alignHorizontalCenters', 'KeyH', 'hcenter'],
      ['align-right', 'actions.alignRight', 'KeyD', 'right'],
      ['align-top', 'actions.alignTop', 'KeyW', 'top'],
      ['align-vcenter', 'actions.alignVerticalCenters', 'KeyV', 'vcenter'],
      ['align-bottom', 'actions.alignBottom', 'KeyS', 'bottom'],
    ] as const
  ).map(([id, label, key, edge]): CanvasAction => ({
    id,
    label,
    menu: 'arrange',
    section: 1,
    keys: [{ code: key, alt: true }],
    edit: true,
    /* one layer aligns in its parent; frames need a second to align to */
    enabled: () => (hasInnerPick() ? true : arrangeCount() >= 2),
    run: () => align(edge),
  })),
  {
    id: 'tidy-up',
    label: 'actions.tidyUp',
    menu: 'arrange',
    section: 2,
    keys: [{ code: 'KeyT', alt: true, ctrl: true, macOnly: true }],
    edit: true,
    enabled: () => arrangeCount() >= 2,
    run: tidy,
  },
  {
    id: 'pack-horizontal',
    label: 'actions.packHorizontal',
    menu: 'arrange',
    section: 3,
    edit: true,
    enabled: () => arrangeCount() >= 2,
    run: () => pack('x'),
  },
  {
    id: 'pack-vertical',
    label: 'actions.packVertical',
    menu: 'arrange',
    section: 3,
    edit: true,
    enabled: () => arrangeCount() >= 2,
    run: () => pack('y'),
  },
  {
    id: 'distribute-horizontal-spacing',
    label: 'actions.distributeHorizontalSpacing',
    menu: 'arrange',
    section: 4,
    keys: [{ code: 'KeyH', alt: true, ctrl: true, macOnly: true }],
    edit: true,
    enabled: () => arrangeCount() >= 3,
    run: () => distributeSpacingOf('x'),
  },
  {
    id: 'distribute-vertical-spacing',
    label: 'actions.distributeVerticalSpacing',
    menu: 'arrange',
    section: 4,
    keys: [{ code: 'KeyV', alt: true, ctrl: true, macOnly: true }],
    edit: true,
    enabled: () => arrangeCount() >= 3,
    run: () => distributeSpacingOf('y'),
  },
  ...(
    [
      ['distribute-left', 'actions.distributeLeft', 'x', 'start'],
      ['distribute-hcenter', 'actions.distributeHorizontalCenters', 'x', 'center'],
      ['distribute-right', 'actions.distributeRight', 'x', 'end'],
      ['distribute-top', 'actions.distributeTop', 'y', 'start'],
      ['distribute-vcenter', 'actions.distributeVerticalCenters', 'y', 'center'],
      ['distribute-bottom', 'actions.distributeBottom', 'y', 'end'],
    ] as const
  ).map(([id, label, axis, edge]): CanvasAction => ({
    id,
    label,
    menu: 'arrange',
    section: 5,
    edit: true,
    enabled: () => arrangeCount() >= 3,
    run: () => distributeEdgesOf(axis, edge),
  })),

  /* ---- Help ---- */
  {
    id: 'shortcuts',
    label: 'actions.keyboardShortcuts',
    menu: 'help',
    section: 0,
    keys: [{ code: 'Slash', ctrl: true, shift: true }],
    run: () => h()?.openShortcuts(),
  },
  {
    id: 'docs',
    label: 'actions.docs',
    menu: 'help',
    section: 1,
    run: () => h()?.openDocs(),
  },
  {
    id: 'customer-support',
    label: 'actions.customerSupport',
    menu: 'help',
    section: 1,
    run: () => h()?.contactSupport(),
  },
]

/** Whether the action can run now: the canvas is open and editable when it
 *  needs to be, and its own test passes. */
export function isEnabled(action: CanvasAction): boolean {
  if (!host) return false
  if (action.edit && !canEdit()) return false
  return action.enabled ? action.enabled() : true
}

/** Run the action from a menu or the palette. */
export function runAction(action: CanvasAction) {
  if (isEnabled(action)) action.run()
}

/** Whether one of the action's chords, pressed with the focus in a field
 *  (`typing`) or not, is the canvas keyboard's to run: the rules
 *  `dispatchActionKey` applies, for a key that reached the desktop menu bar
 *  instead of the page. */
export function takesKey(action: CanvasAction, typing: boolean): boolean {
  if (!host || host.presenting || action.hintOnly) return false
  return !typing || !!action.keys?.some((chord) => chord.global)
}

type KeyEventLike = Pick<
  KeyboardEvent,
  'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat' | 'preventDefault'
>

/** The canvas's keyboard: run the first enabled action bound to the chord.
 *  `typing` says the key landed in a field, where only global chords act.
 *  True when an action took the key. A chord whose action is disabled, or
 *  found nothing to act on, is left to the next binding and the browser. */
export function dispatchActionKey(e: KeyEventLike, typing: boolean, mac = IS_MAC): boolean {
  if (!host || host.presenting) return false
  for (const action of ACTIONS) {
    if (action.hintOnly) continue
    if (!action.keys?.some((chord) => (!typing || chord.global) && matchesChord(e, chord, mac))) continue
    if (!isEnabled(action)) continue
    /* a held key repeats only what is safe to repeat */
    if (e.repeat && !REPEATABLE.has(action.id)) {
      e.preventDefault()
      return true
    }
    if (action.run() === false) continue
    e.preventDefault()
    return true
  }
  return false
}

const REPEATABLE = new Set([
  'undo',
  'redo',
  'zoom-in',
  'zoom-out',
  'font-bigger',
  'font-smaller',
  'zoom-next-frame',
  'zoom-previous-frame',
  'find-next-frame',
  'find-previous-frame',
])
