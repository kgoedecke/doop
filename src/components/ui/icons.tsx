/** Doop's UI icon set: Hugeicons' free stroke set (MIT), drawn on a 24 grid
 *  with round caps and joins and soft, squircle-cornered shapes, at the
 *  ICON_STROKE weight of the white system, so a glyph sits as quietly as the
 *  1px rings around it.
 *
 *  Every icon is re-exported under the name the app already uses, wrapped to
 *  default to 16px, the size inside a button. `size` picks a named step from
 *  ICON_SIZE (`size="rail"` for the 14px rail rows, menus and the editor
 *  chrome) or takes a pixel count, and holds inside a Button or a tab, whose
 *  own svg rule would otherwise make it 16px. Without `size`, width/height
 *  or a `size-*` class override the default; a caller's own `strokeWidth`
 *  always wins. */

import type { SVGProps } from 'react'
import {
  Activity01Icon as Activity01,
  AlignEndHorizontalIcon as AlignEndHorizontal,
  AlignEndVerticalIcon as AlignEndVertical,
  AlignHorizontalCenterIcon as AlignHorizontalCenter,
  AlignHorizontalSpaceAroundIcon as AlignHorizontalSpaceAround,
  AlignStartHorizontalIcon as AlignStartHorizontal,
  AlignStartVerticalIcon as AlignStartVertical,
  AlignVerticalCenterIcon as AlignVerticalCenter,
  AlignVerticalSpaceAroundIcon as AlignVerticalSpaceAround,
  ArrowDown02Icon as ArrowDown02,
  ArrowLeft02Icon as ArrowLeft02,
  ArrowRight02Icon as ArrowRight02,
  ArrowUp02Icon as ArrowUp02,
  BellIcon as Bell,
  BlocksIcon as Blocks,
  BookOpen01Icon as BookOpen01,
  BrainIcon as Brain,
  Building06Icon as Building06,
  Calendar03Icon as Calendar03,
  CheckIcon as Check,
  ChevronDownIcon as ChevronDown,
  ChevronLeftIcon as ChevronLeft,
  ChevronRightIcon as ChevronRight,
  ChevronsDownUpIcon as ChevronsDownUp,
  CircleIcon as Circle,
  CircleDashedIcon as CircleDashed,
  CirclePlusIcon as CirclePlus,
  ClipboardIcon as Clipboard,
  Clock01Icon as Clock01,
  CodeXmlIcon as CodeXml,
  CopyIcon as Copy,
  CreditCardIcon as CreditCard,
  Cursor02Icon as Cursor02,
  Delete02Icon as Delete02,
  Download01Icon as Download01,
  DropletIcon as Droplet,
  EllipsisIcon as Ellipsis,
  ExternalLinkIcon as ExternalLink,
  EyeIcon as Eye,
  EyeOffIcon as EyeOff,
  FileEmpty02Icon as FileEmpty02,
  FileTextIcon as FileText,
  Flag02Icon as Flag02,
  FlipHorizontalIcon as FlipHorizontal,
  FlipVerticalIcon as FlipVertical,
  Folder01Icon as Folder01,
  FolderPlusIcon as FolderPlus,
  FrameIcon as Frame,
  GithubIcon as Github,
  Globe02Icon as Globe02,
  GridViewIcon as GridView,
  HandIcon as Hand,
  HelpCircleIcon as HelpCircle,
  HistoryIcon as History,
  Image01Icon as Image01,
  Key01Icon as Key01,
  Layers01Icon as Layers01,
  Layout3ColumnIcon as Layout3Column,
  LayoutTemplateIcon as LayoutTemplate,
  Link02Icon as Link02,
  LogOutIcon as LogOut,
  MenuIcon as Menu,
  MessageCircleIcon as MessageCircle,
  MessageSquareIcon as MessageSquare,
  MinusIcon as Minus,
  MonitorIcon as Monitor,
  Moon02Icon as Moon02,
  MousePointerClickIcon as MousePointerClick,
  PanelLeftIcon as PanelLeft,
  PanelLeftCloseIcon as PanelLeftClose,
  PanelLeftOpenIcon as PanelLeftOpen,
  PanelRightCloseIcon as PanelRightClose,
  PaperclipIcon as Paperclip,
  PenTool03Icon as PenTool03,
  PencilEdit01Icon as PencilEdit01,
  PencilRulerIcon as PencilRuler,
  PictureInPicture01Icon as PictureInPicture01,
  PlayIcon as Play,
  PlusIcon as Plus,
  PuzzleIcon as Puzzle,
  RadioTowerIcon as RadioTower,
  RadiusIcon as Radius,
  RefreshCwIcon as RefreshCw,
  Route01Icon as Route01,
  Search01Icon as Search01,
  Settings02Icon as Settings02,
  Share03Icon as Share03,
  Share08Icon as Share08,
  Shield01Icon as Shield01,
  SlidersHorizontalIcon as SlidersHorizontal,
  SparklesIcon as Sparkles,
  SquareIcon as Square,
  SquareDashedIcon as SquareDashed,
  SquareLock02Icon as SquareLock02,
  SquareMousePointerIcon as SquareMousePointer,
  Sun03Icon as Sun03,
  TextAlignCenterIcon as TextAlignCenter,
  TextAlignJustifyIcon as TextAlignJustify,
  TextAlignLeftIcon as TextAlignLeft,
  TextAlignRightIcon as TextAlignRight,
  TextWrapIcon as TextWrap,
  TypeIcon as Type,
  Unlink02Icon as Unlink02,
  Upload01Icon as Upload01,
  UserIcon as User,
  UsersIcon as Users,
  WorkflowIcon as Workflow,
  XIcon as X,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'

type SvgProps = Omit<SVGProps<SVGSVGElement>, 'ref'>

/** The stroke every chrome glyph is drawn at, in the icon's 24-unit grid. */
export const ICON_STROKE = 1.15

/** The sizes a glyph is drawn at, by where it sits: 14px beside a rail row's,
 *  a menu item's or a tab's 12.5px label (a hair under its cap height), 16px
 *  inside a button. One table, so a page cannot mix them by accident. */
export const ICON_SIZE = { rail: 14, button: 16 } as const

export type IconSize = keyof typeof ICON_SIZE | number

export type IconProps = SvgProps & { size?: IconSize }

function px(size: IconSize = 'button') {
  return typeof size === 'number' ? size : ICON_SIZE[size]
}

/* An asked-for size goes inline as well as into the attributes: Button and
   TabsTrigger size any descendant svg without a `size-*` class to 16px, and
   a stylesheet rule beats an attribute but not an inline style. Unasked, the
   attributes alone keep the 16px default overridable by those parents. */
function sized({ size, style, ...props }: Omit<IconProps, 'strokeWidth'>) {
  const side = px(size)
  return {
    width: side,
    height: side,
    style: size === undefined ? style : { width: side, height: side, ...style },
    ...props,
  }
}

/** `motion` names a rail glyph whose hover motion styles.css draws
 *  (`[data-icon-motion] svg[data-icon="…"]`), keyed on the glyph's child order,
 *  so swapping that glyph means revisiting its rule there. */
function icon(glyph: IconSvgElement, motion?: string) {
  return function Icon({ strokeWidth = ICON_STROKE, ...props }: IconProps) {
    return (
      <HugeiconsIcon icon={glyph} strokeWidth={Number(strokeWidth)} data-icon={motion} aria-hidden {...sized(props)} />
    )
  }
}

export const XIcon = icon(X)
export const ArrowDownIcon = icon(ArrowDown02)
export const HorizontalPaddingIcon = icon(AlignHorizontalSpaceAround)
export const VerticalPaddingIcon = icon(AlignVerticalSpaceAround)
export const WrapTextIcon = icon(TextWrap)
export const SquareDashedIcon = icon(SquareDashed)
export const MoreHorizontalIcon = icon(Ellipsis)
export const ShareIcon = icon(Share08)
export const CopyIcon = icon(Copy)
export const ClipboardIcon = icon(Clipboard)
export const TrashIcon = icon(Delete02)
export const CheckIcon = icon(Check)
export const ChevronRightIcon = icon(ChevronRight)
export const ChevronDownIcon = icon(ChevronDown)
export const AlignStartVerticalIcon = icon(AlignStartVertical)
export const AlignCenterVerticalIcon = icon(AlignHorizontalCenter)
export const AlignEndVerticalIcon = icon(AlignEndVertical)
export const AlignStartHorizontalIcon = icon(AlignStartHorizontal)
export const AlignCenterHorizontalIcon = icon(AlignVerticalCenter)
export const AlignEndHorizontalIcon = icon(AlignEndHorizontal)
export const FlipHorizontal2Icon = icon(FlipHorizontal)
export const FlipVertical2Icon = icon(FlipVertical)
export const CircleDashedIcon = icon(CircleDashed)
export const DropletIcon = icon(Droplet)
export const RadiusIcon = icon(Radius)
export const AlignLeftIcon = icon(TextAlignLeft)
export const AlignCenterIcon = icon(TextAlignCenter)
export const AlignRightIcon = icon(TextAlignRight)
export const AlignJustifyIcon = icon(TextAlignJustify)
export const LinkIcon = icon(Link02)
export const UnlinkIcon = icon(Unlink02)
export const GithubIcon = icon(Github)
export const SyncIcon = icon(RefreshCw)
export const ImportIcon = icon(Download01)
/** Import's counterpart: the arrow leaving the box. */
export const ExportIcon = icon(ExternalLink)
export const PulseIcon = icon(Activity01)
export const BellIcon = icon(Bell)
export const SparkIcon = icon(Sparkles)
export const SearchIcon = icon(Search01, 'search')
export const PlusIcon = icon(Plus)
export const CollapseAllIcon = icon(ChevronsDownUp)
export const PanelLeftIcon = icon(PanelLeft)
/* Hugeicons draws its left-panel chevrons the other way round from their
   names: PanelLeftOpen's points left, the way collapsing goes. */
export const PanelCollapseIcon = icon(PanelLeftOpen, 'panel-close')
export const PanelExpandIcon = icon(PanelLeftClose, 'panel-open')
export const PanelCollapseRightIcon = icon(PanelRightClose)
/** the canvas panels' two layouts (Settings → Appearance) */
export const PanelsFloatingIcon = icon(PictureInPicture01)
export const PanelsDockedIcon = icon(Layout3Column)
export const LayersIcon = icon(Layers01)
export const FrameIcon = icon(Frame)
/** a page of the canvas, in the Layers panel's Pages list */
export const PageIcon = icon(FileEmpty02)
/** a PDF document, the Export modal's PDF destination */
export const PdfIcon = icon(FileText)
export const BoxIcon = icon(Square)
export const TextIcon = icon(Type)
export const ImageIcon = icon(Image01)
export const VectorIcon = icon(PenTool03)
export const PlayIcon = icon(Play)
export const ArrowUpIcon = icon(ArrowUp02)
export const ArrowLeftIcon = icon(ArrowLeft02)
export const ArrowRightIcon = icon(ArrowRight02)
export const ChevronLeftIcon = icon(ChevronLeft)
export const GridIcon = icon(GridView, 'grid')
export const ListIcon = icon(Menu)
export const UserIcon = icon(User, 'user')
export const UsersIcon = icon(Users, 'users')
export const ClockIcon = icon(Clock01)
export const GearIcon = icon(Settings02)
export const ShieldIcon = icon(Shield01)
export const HelpIcon = icon(HelpCircle)
export const KeyIcon = icon(Key01)
export const LogOutIcon = icon(LogOut)
export const AttachmentIcon = icon(Paperclip)
export const BrainIcon = icon(Brain)
/** a shared workspace — the org's building */
export const BuildingIcon = icon(Building06, 'building')
export const CreditCardIcon = icon(CreditCard)
export const LockIcon = icon(SquareLock02)
export const DesktopIcon = icon(Monitor)
export const DownloadIcon = icon(Download01)
export const PuzzleIcon = icon(Puzzle)
/* the theme switch: sun for light, moon for dark */
export const SunIcon = icon(Sun03)
export const MoonIcon = icon(Moon02)

/* the editor chrome's own glyphs */
export const FolderIcon = icon(Folder01)
export const BookOpenIcon = icon(BookOpen01)
export const SlidersIcon = icon(SlidersHorizontal)
export const PointerIcon = icon(Cursor02)
export const HandIcon = icon(Hand)
/** the select tool's arrow — the same glyph as PointerIcon */
export const CursorIcon = icon(Cursor02)
/** comments: the round bubble, as on the side panel's Comments tab in the design */
export const CommentIcon = icon(MessageCircle)
export const CodeIcon = icon(CodeXml)
export const EditIcon = icon(PencilEdit01)
export const EyeIcon = icon(Eye)
export const EyeClosedIcon = icon(EyeOff)
export const CircleIcon = icon(Circle)
/** a web page — the import-a-site tool, and the community gallery */
export const WebIcon = icon(Globe02, 'globe')
/** a live app broadcasting its screens — the design-sync import */
export const RadioTowerIcon = icon(RadioTower)
export const MinusIcon = icon(Minus)
/** zoom to fit: the four corners of the viewport */
/** sharing a canvas: the box with the arrow leaving it upward */
export const ShareUpIcon = icon(Share03)

/* the signed-in home: its rail, suggestion chips and composer */
/** a new workspace — a folder with a plus */
export const FolderPlusIcon = icon(FolderPlus, 'folder-plus')
/** automations: two linked steps */
export const WorkflowIcon = icon(Workflow, 'workflow')
/** integrations: building blocks */
export const BlocksIcon = icon(Blocks, 'blocks')
/** connect an agent: a plus in a ring */
export const CirclePlusIcon = icon(CirclePlus, 'circle-plus')
/** import: the arrow entering from above */
export const UploadIcon = icon(Upload01)
export const CalendarIcon = icon(Calendar03)
/** what changed: the clock turned back */
export const HistoryIcon = icon(History)
/* prototypes: the editor's Prototype mode, a flow's start, the player's hotspot hint */
export const PrototypeIcon = icon(MousePointerClick)
/** the tool rail's mode switch: drawing and editing, or wiring up the flow */
export const EditModeIcon = icon(PencilRuler)
export const PrototypeModeIcon = icon(Route01)
export const FlowStartIcon = icon(Flag02)
export const HotspotIcon = icon(SquareMousePointer)
/** review comments: the square bubble */
export const MessageSquareIcon = icon(MessageSquare)
/** draft a page: a page skeleton */
export const LayoutTemplateIcon = icon(LayoutTemplate)
