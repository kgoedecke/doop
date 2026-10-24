/** Doop's UI icon set: Lucide (ISC), drawn on a 24 grid with round caps and
 *  joins at a 1.15 stroke — the hairline weight of the white system, so a
 *  glyph sits as quietly as the 1px rings around it.
 *
 *  Every icon is re-exported under the name the app already uses, wrapped to
 *  default to 16px, the size inside a button. `size` picks a named step from
 *  ICON_SIZE (`size="rail"` for the 14px rail rows, menus and the editor
 *  chrome) or takes a pixel count, and holds inside a Button or a tab, whose
 *  own svg rule would otherwise make it 16px. Without `size`, width/height
 *  or a `size-*` class override the default; a caller's own `strokeWidth`
 *  always wins. */

import type { ComponentType, SVGProps } from 'react'
import {
  Activity,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  FlipHorizontal2,
  FlipVertical2,
  CircleDashed,
  Droplet,
  Radius,
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ArrowLeft,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bell,
  Blocks,
  Bookmark,
  Calendar,
  BookOpen,
  Brain,
  Building2,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  Circle,
  CircleHelp,
  CirclePlus,
  Clipboard,
  CodeXml,
  Command,
  Clock,
  Compass,
  Copy,
  CreditCard,
  Download,
  Ellipsis,
  Eye,
  EyeOff,
  ExternalLink,
  Folder,
  FolderPlus,
  File,
  Frame,
  Globe,
  Hand,
  Image,
  Key,
  Layers,
  LayoutGrid,
  LayoutTemplate,
  Link2,
  Lock,
  LogOut,
  MapPin,
  Menu,
  Minus,
  MousePointer2,
  MessageCircle,
  MessageSquare,
  Monitor,
  Moon,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Pencil,
  PenTool,
  Play,
  Plus,
  Puzzle,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Scan,
  Search,
  Settings,
  Share,
  Share2,
  SlidersHorizontal,
  AlignHorizontalSpaceAround,
  AlignVerticalSpaceAround,
  WrapText,
  SquareDashed,
  Shield,
  Sparkles,
  Square,
  Sun,
  Trash2,
  Type,
  Upload,
  Unlink2,
  User,
  Users,
  Workflow,
  X,
} from 'lucide-react'

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
function sized({ size, style, ...props }: IconProps): SvgProps {
  const side = px(size)
  return {
    width: side,
    height: side,
    style: size === undefined ? style : { width: side, height: side, ...style },
    ...props,
  }
}

function icon(Base: ComponentType<SvgProps>) {
  return function Icon(props: IconProps) {
    return <Base strokeWidth={ICON_STROKE} aria-hidden {...sized(props)} />
  }
}

export const XIcon = icon(X)
export const ArrowDownIcon = icon(ArrowDown)
export const HorizontalPaddingIcon = icon(AlignHorizontalSpaceAround)
export const VerticalPaddingIcon = icon(AlignVerticalSpaceAround)
export const WrapTextIcon = icon(WrapText)
export const SquareDashedIcon = icon(SquareDashed)
export const MoreHorizontalIcon = icon(Ellipsis)
export const ShareIcon = icon(Share2)
export const CopyIcon = icon(Copy)
export const ClipboardIcon = icon(Clipboard)
export const TrashIcon = icon(Trash2)
export const CheckIcon = icon(Check)
export const ChevronRightIcon = icon(ChevronRight)
export const ChevronDownIcon = icon(ChevronDown)
export const AlignStartVerticalIcon = icon(AlignStartVertical)
export const AlignCenterVerticalIcon = icon(AlignCenterVertical)
export const AlignEndVerticalIcon = icon(AlignEndVertical)
export const AlignStartHorizontalIcon = icon(AlignStartHorizontal)
export const AlignCenterHorizontalIcon = icon(AlignCenterHorizontal)
export const AlignEndHorizontalIcon = icon(AlignEndHorizontal)
export const FlipHorizontal2Icon = icon(FlipHorizontal2)
export const FlipVertical2Icon = icon(FlipVertical2)
export const CircleDashedIcon = icon(CircleDashed)
export const DropletIcon = icon(Droplet)
export const RadiusIcon = icon(Radius)
export const AlignLeftIcon = icon(AlignLeft)
export const AlignCenterIcon = icon(AlignCenter)
export const AlignRightIcon = icon(AlignRight)
export const AlignJustifyIcon = icon(AlignJustify)
export const LinkIcon = icon(Link2)
export const UnlinkIcon = icon(Unlink2)
/** Lucide dropped its brand marks; this is its last GitHub outline, kept on
 *  the same grid and stroke as the rest of the set. */
export function GithubIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...sized(props)}
    >
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  )
}
export const SyncIcon = icon(RefreshCw)
export const ImportIcon = icon(Download)
/** Import's counterpart: the arrow leaving the box. */
export const ExportIcon = icon(ExternalLink)
export const PulseIcon = icon(Activity)
export const BellIcon = icon(Bell)
export const ChatIcon = icon(MessageCircle)
export const SparkIcon = icon(Sparkles)
export const SearchIcon = icon(Search)
export const PlusIcon = icon(Plus)
export const CollapseAllIcon = icon(ChevronsDownUp)
export const PanelLeftIcon = icon(PanelLeft)
export const PanelCollapseIcon = icon(PanelLeftClose)
export const PanelExpandIcon = icon(PanelLeftOpen)
export const PanelCollapseRightIcon = icon(PanelRightClose)
export const PanelExpandRightIcon = icon(PanelRightOpen)
export const LayersIcon = icon(Layers)
export const FrameIcon = icon(Frame)
/** a page of the canvas, in the Layers panel's Pages list */
export const PageIcon = icon(File)
export const BoxIcon = icon(Square)
export const TextIcon = icon(Type)
export const ImageIcon = icon(Image)
export const VectorIcon = icon(PenTool)
export const BookmarkIcon = icon(Bookmark)
export const PlayIcon = icon(Play)
export const ArrowUpIcon = icon(ArrowUp)
export const ArrowLeftIcon = icon(ArrowLeft)
export const ArrowRightIcon = icon(ArrowRight)
export const ChevronLeftIcon = icon(ChevronLeft)
export const GridIcon = icon(LayoutGrid)
export const ListIcon = icon(Menu)
export const UserIcon = icon(User)
export const UsersIcon = icon(Users)
export const CompassIcon = icon(Compass)
export const ClockIcon = icon(Clock)
export const GearIcon = icon(Settings)
export const ShieldIcon = icon(Shield)
export const HelpIcon = icon(CircleHelp)
export const KeyIcon = icon(Key)
export const LogOutIcon = icon(LogOut)
export const AttachmentIcon = icon(Paperclip)
export const BrainIcon = icon(Brain)
/** a shared workspace — the org's building */
export const BuildingIcon = icon(Building2)
export const CreditCardIcon = icon(CreditCard)
export const LockIcon = icon(Lock)
export const DesktopIcon = icon(Monitor)
export const DownloadIcon = icon(Download)
export const PuzzleIcon = icon(Puzzle)
/* the theme switch: sun for light, moon for dark */
export const SunIcon = icon(Sun)
export const MoonIcon = icon(Moon)

/* the editor chrome's own glyphs */
export const FolderIcon = icon(Folder)
export const BookOpenIcon = icon(BookOpen)
export const SlidersIcon = icon(SlidersHorizontal)
export const PointerIcon = icon(MousePointer2)
export const HandIcon = icon(Hand)
/** the select tool's arrow — the same glyph as PointerIcon */
export const CursorIcon = icon(MousePointer2)
/** comments: the round bubble, as on the side panel's Comments tab in the design */
export const CommentIcon = icon(MessageCircle)
export const CodeIcon = icon(CodeXml)
export const EditIcon = icon(Pencil)
export const PinIcon = icon(MapPin)
export const EyeIcon = icon(Eye)
export const EyeClosedIcon = icon(EyeOff)
export const CircleIcon = icon(Circle)
/** a web page — the import-a-site tool, and the community gallery */
export const WebIcon = icon(Globe)
/** a live app broadcasting its screens — the design-sync import */
export const RadioTowerIcon = icon(RadioTower)
export const MinusIcon = icon(Minus)
/** zoom to fit: the four corners of the viewport */
export const FitIcon = icon(Scan)
/** sharing a canvas: the box with the arrow leaving it upward */
export const ShareUpIcon = icon(Share)

/* the signed-in home: its rail, suggestion chips and composer */
/** a new workspace — a folder with a plus */
export const FolderPlusIcon = icon(FolderPlus)
/** automations: two linked steps */
export const WorkflowIcon = icon(Workflow)
/** integrations: building blocks */
export const BlocksIcon = icon(Blocks)
/** connect an agent: a plus in a ring */
export const CirclePlusIcon = icon(CirclePlus)
/** import: the arrow entering from above */
export const UploadIcon = icon(Upload)
export const CalendarIcon = icon(Calendar)
/** what changed: the clock turned back */
export const HistoryIcon = icon(RotateCcw)
/** review comments: the square bubble */
export const MessageSquareIcon = icon(MessageSquare)
/** draft a page: a page skeleton */
export const LayoutTemplateIcon = icon(LayoutTemplate)
/** the ⌘ key, in shortcut hints */
export const CommandIcon = icon(Command)
