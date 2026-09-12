/** Doop's UI icon set: Iconoir (MIT), drawn on a 24 grid at a 1.5 stroke with
 *  round caps and joins — light enough to sit inside the frosted chips.
 *
 *  Every icon is re-exported under the name the app already uses, wrapped to
 *  default to 16px (Iconoir's own default is 1.5em) — pass width/height or a
 *  `size-*` class to override, exactly as before. `PlayIcon` is the filled
 *  variant, as the transport control always was. */

import type { ComponentType, SVGProps } from 'react'
import {
  Activity,
  Clock,
  Attachment,
  Brain,
  Compass,
  Group,
  HelpCircle,
  LogOut,
  Menu,
  NavArrowLeft,
  Settings,
  Shield,
  User,
  ViewGrid,
  ArrowUp,
  Bookmark,
  Check,
  Compress,
  Copy,
  DesignNib,
  FrameAltEmpty,
  Github,
  Import,
  MediaImage,
  MoreHoriz,
  ViewStructureUp,
  NavArrowDown,
  NavArrowRight,
  PlaySolid,
  Plus,
  RefreshDouble,
  Search,
  ShareAndroid,
  SidebarCollapse,
  SidebarExpand,
  SparkSolid,
  Square,
  Text,
  Trash,
  Xmark,
} from 'iconoir-react'

type IconProps = Omit<SVGProps<SVGSVGElement>, 'ref'>

function icon(Base: ComponentType<IconProps>, extra?: IconProps) {
  return function Icon(props: IconProps) {
    return <Base width={16} height={16} {...extra} {...props} />
  }
}

/* The right-hand panel controls are the sidebar glyphs mirrored: Iconoir only
   draws the left-anchored pair. */
const mirrored = { style: { transform: 'scaleX(-1)' } } satisfies IconProps

export const XIcon = icon(Xmark)
export const MoreHorizontalIcon = icon(MoreHoriz)
export const ShareIcon = icon(ShareAndroid)
export const CopyIcon = icon(Copy)
export const TrashIcon = icon(Trash)
export const CheckIcon = icon(Check)
export const ChevronRightIcon = icon(NavArrowRight)
export const ChevronDownIcon = icon(NavArrowDown)
export const GithubIcon = icon(Github)
export const SyncIcon = icon(RefreshDouble)
export const ImportIcon = icon(Import)
export const PulseIcon = icon(Activity)
export const SparkIcon = icon(SparkSolid)
export const SearchIcon = icon(Search)
export const PlusIcon = icon(Plus)
export const CollapseAllIcon = icon(Compress)
export const PanelCollapseIcon = icon(SidebarCollapse)
export const PanelExpandIcon = icon(SidebarExpand)
export const PanelCollapseRightIcon = icon(SidebarCollapse, mirrored)
export const PanelExpandRightIcon = icon(SidebarExpand, mirrored)
export const LayersIcon = icon(ViewStructureUp)
export const FrameIcon = icon(FrameAltEmpty)
export const BoxIcon = icon(Square)
export const TextIcon = icon(Text)
export const ImageIcon = icon(MediaImage)
export const VectorIcon = icon(DesignNib)
export const BookmarkIcon = icon(Bookmark)
export const PlayIcon = icon(PlaySolid)
export const ArrowUpIcon = icon(ArrowUp)
export const ChevronLeftIcon = icon(NavArrowLeft)
export const GridIcon = icon(ViewGrid)
export const ListIcon = icon(Menu)
export const UserIcon = icon(User)
export const UsersIcon = icon(Group)
export const CompassIcon = icon(Compass)
export const ClockIcon = icon(Clock)
export const GearIcon = icon(Settings)
export const ShieldIcon = icon(Shield)
export const HelpIcon = icon(HelpCircle)
export const LogOutIcon = icon(LogOut)
export const AttachmentIcon = icon(Attachment)
export const BrainIcon = icon(Brain)
