import { useId, type JSX } from 'react'
import { cn } from '@/lib/utils'
import { ImageIcon, PdfIcon, PuzzleIcon, RadioTowerIcon, ServerIcon, VectorIcon, WebIcon } from './icons'
import canvaLogo from './brand/canva.svg'
import linearLogo from './brand/linear.svg'
import slackLogo from './brand/slack.svg'

/**
 * Every third-party logo the product wears, from one place. A mark is a
 * square `size` px box with the brand's glyph centred in it, drawn in the
 * brand's own colours where it has them (Figma, Google, Gemini, Meta,
 * Photoshop, Canva, Slack, Linear, Microsoft) and in `currentColor` where the brand
 * itself asks for the text colour (GitHub, OpenAI, Cursor, OpenRouter, Apple).
 * Claude's default is Anthropic's terracotta; `color` overrides any of the
 * single-colour marks.
 *
 * Paths: Simple Icons (CC0) for Claude, OpenAI, Cursor and GitHub; the
 * providers' own sign-in branding assets for Google, Apple and Microsoft;
 * each company's brand page for the rest. Wordmarks and tiles that belong to
 * a feature (the automation chain's clock, the integration tiles) stay with
 * that feature and compose a BrandMark.
 */
export type Brand =
  | 'figma'
  | 'github'
  | 'canva'
  | 'photoshop'
  | 'meta'
  | 'claude'
  | 'openai'
  | 'cursor'
  | 'gemini'
  | 'openrouter'
  | 'google'
  | 'apple'
  | 'microsoft'
  | 'slack'
  | 'linear'

export interface BrandMarkProps {
  brand: Brand
  /** the square the mark fills, in px: 16 in logo rows, 18 on sign-in buttons, 24 on picker tiles */
  size?: number
  /** fill for the single-colour marks; the multi-colour ones ignore it */
  color?: string
  className?: string
}

/** Anthropic's terracotta: what the Claude mark wears unless told otherwise. */
export const CLAUDE_COLOR = '#D97757'

const CLAUDE_PATH =
  'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z'

const OPENAI_PATH =
  'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z'

/** OpenRouter's "OR" mark, the one its site and app icon wear (Iconify logos, MIT). */
const OPENROUTER_PATH =
  'M198.973 0c29.97 0 54.265 24.296 54.265 54.265s-24.294 54.266-54.265 54.266l53.826 53.826c6.838 6.837 1.995 18.528-7.673 18.528H90.442C40.492 180.885 0 140.392 0 90.442S40.492 0 90.442 0zM90.443 36.177c-29.97 0-54.266 24.295-54.266 54.265s24.295 54.265 54.265 54.265s54.265-24.295 54.265-54.265s-24.295-54.265-54.265-54.265'

/** ByteDance's four bars, which its Seed lab (Seedream) wears in a blue-teal blend. */
const BYTEDANCE_PATH =
  'M19.877 1.469L24 2.532v18.942l-4.123 1.056zM6.53 10.897l4.115 1.064v8.978L6.53 22.003zM0 2.572l4.115 1.064v16.736L0 21.428zm17.455 5.62V19.3l-4.122-1.065V9.257z'

const CURSOR_PATH =
  'M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23'

/** GitHub's filled mark, the one its favicon shows. */
const GITHUB_PATH =
  'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12'

/** The Gemini four-point spark. */
const GEMINI_PATH =
  'M12 1c.55 5.93 5.07 10.45 11 11-5.93.55-10.45 5.07-11 11-.55-5.93-5.07-10.45-11-11C6.93 11.45 11.45 6.93 12 1Z'

const APPLE_PATH =
  'M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701'

const META_PATH =
  'M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.499-1.584.325-.217.65-.234.972-.234z'

const PHOTOSHOP_TILE =
  'M34.4678 0H7.53225C3.3723 0 0 3.3723 0 7.53225V34.4678C0 38.6277 3.3723 42 7.53225 42H34.4678C38.6277 42 42 38.6277 42 34.4678V7.53225C42 3.3723 38.6277 0 34.4678 0Z'
const PHOTOSHOP_P =
  'M14.6661 11.1485C20.1565 11.1485 23.2484 13.7203 23.2484 18.0259C23.2484 23.0539 19.0584 25.0767 15.1284 25.0767H12.47V30.5093H7.09517V11.1485H14.6661ZM12.47 15.7431V20.4821H14.8395C16.4866 20.4821 17.6425 19.8175 17.6425 18.1415C17.6425 16.61 16.66 15.7431 14.9551 15.7431H12.47Z'
const PHOTOSHOP_S =
  'M24.3408 29.5557L24.3698 25.0767C25.9013 26.0881 28.0396 26.7238 29.5134 26.7238C30.5247 26.7238 30.9871 26.4348 30.9871 25.9147C30.9871 25.3368 30.3514 25.1056 29.1377 24.7299C26.797 24.0364 24.2253 23.0828 24.2253 20.0198C24.2253 16.8989 26.797 15.1652 30.5247 15.1652C32.2874 15.1652 33.7323 15.4252 35.0037 15.9743L34.9748 20.251C33.9634 19.6441 31.9696 19.0951 30.6692 19.0951C29.7156 19.0951 29.34 19.3841 29.34 19.8175C29.34 20.3376 29.8023 20.4821 31.1894 20.9156C33.8768 21.7247 36.1307 22.5916 36.1307 25.7413C36.1307 28.7465 33.6745 30.7693 29.8312 30.7693C27.8084 30.7693 25.9013 30.4226 24.3408 29.5557Z'

interface GlyphProps {
  size: number
  color?: string
  className?: string
}

/** a single-path mark on the 24 grid, in `color` or the text colour */
function path(d: string, defaultColor = 'currentColor') {
  return function Glyph({ size, color, className }: GlyphProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={color ?? defaultColor}
        className={className}
        aria-hidden
      >
        <path d={d} />
      </svg>
    )
  }
}

/** an asset that is already the whole mark (tile and glyph in one file) */
function asset(src: string) {
  return function Glyph({ size, className }: GlyphProps) {
    return <img src={src} width={size} height={size} className={cn('flex-none', className)} alt="" aria-hidden />
  }
}

/** a white glyph on the brand's own dark tile, cornered like the integration tiles */
function tiled(src: string, background: string, ratio: number) {
  return function Glyph({ size, className }: GlyphProps) {
    const glyph = Math.round(size * ratio)
    return (
      <span
        aria-hidden
        className={cn('inline-grid flex-none place-items-center', className)}
        style={{ width: size, height: size, borderRadius: Math.round(size * 0.29), background }}
      >
        <img src={src} alt="" width={glyph} height={glyph} />
      </span>
    )
  }
}

function Figma({ size, className }: GlyphProps) {
  /* the mark is 38 wide on a 57 grid; the viewBox pads it to a square */
  return (
    <svg width={size} height={size} viewBox="-9.5 0 57 57" className={className} aria-hidden>
      <path fill="#1ABCFE" d="M19 28.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 0 1-19 0z" />
      <path fill="#0ACF83" d="M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5a9.5 9.5 0 1 1-19 0z" />
      <path fill="#FF7262" d="M19 0v19h9.5a9.5 9.5 0 1 0 0-19H19z" />
      <path fill="#F24E1E" d="M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5z" />
      <path fill="#A259FF" d="M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5z" />
    </svg>
  )
}

function Google({ size, className }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3c-1.07.72-2.45 1.15-4.06 1.15-3.13 0-5.77-2.11-6.72-4.95H1.28v3.09A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.28 14.29A7.2 7.2 0 0 1 4.9 12c0-.8.14-1.57.38-2.29V6.62H1.28a12 12 0 0 0 0 10.76l4-3.09Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.62l4 3.09C6.23 6.88 8.87 4.77 12 4.77Z"
      />
    </svg>
  )
}

function Microsoft({ size, className }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 21 21" className={className} aria-hidden>
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  )
}

/** Gemini's star in its gradient, blue through violet to rose, as doop.design
 *  draws it. The gradient needs an id of its own, so two marks on one page do
 *  not share one. */
function Gemini({ size, className }: GlyphProps) {
  const id = useId()
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={cn('flex-none', className)} aria-hidden>
      <GeminiGradient id={id} />
      <path fill={`url(#${id})`} d={GEMINI_PATH} />
    </svg>
  )
}

function GeminiGradient({ id }: { id: string }) {
  return (
    <defs>
      <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#4F8BFF" />
        <stop offset="0.6" stopColor="#9B72F6" />
        <stop offset="1" stopColor="#D96570" />
      </linearGradient>
    </defs>
  )
}

/** OpenRouter's OR in the text colour; its black tile is the AppIcon's. */
function OpenRouter({ size, color = 'currentColor', className }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={cn('flex-none', className)} aria-hidden>
      <path fill={color} transform="translate(0 3.52) scale(0.09375)" d={OPENROUTER_PATH} />
    </svg>
  )
}

/** Adobe's Ps app mark (the 2025 icon from adobe.com): the dark tile with
 *  the two letters as a vector. */
function Photoshop({ size, className }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 42 42" className={cn('flex-none', className)} aria-hidden>
      <path fill="#001e36" d={PHOTOSHOP_TILE} />
      <path fill="#31a8ff" d={PHOTOSHOP_P} />
      <path fill="#31a8ff" d={PHOTOSHOP_S} />
    </svg>
  )
}

const MARKS: Record<Brand, (props: GlyphProps) => JSX.Element> = {
  figma: Figma,
  github: path(GITHUB_PATH),
  canva: asset(canvaLogo),
  photoshop: Photoshop,
  meta: path(META_PATH, '#0866FF'),
  claude: path(CLAUDE_PATH, CLAUDE_COLOR),
  openai: path(OPENAI_PATH),
  cursor: path(CURSOR_PATH),
  gemini: Gemini,
  openrouter: OpenRouter,
  google: Google,
  apple: path(APPLE_PATH),
  microsoft: Microsoft,
  slack: tiled(slackLogo, '#4A154B', 0.55),
  linear: tiled(linearLogo, '#090A0C', 0.58),
}

export const BRANDS = Object.keys(MARKS) as Brand[]

export function BrandMark({ brand, size = 16, color, className }: BrandMarkProps) {
  const Glyph = MARKS[brand]
  return <Glyph size={size} color={color} className={className} />
}

/** The providers an agent can run on, and the places a design comes from or
 *  goes to (import sources, export formats), as app icons. */
export type AppIconBrand =
  | 'claude'
  | 'claude-code'
  | 'openai'
  | 'gemini'
  | 'openrouter'
  | 'seedream'
  | 'codex'
  | 'cursor'
  | 'mcp'
  | 'headless'
  | 'github'
  | 'figma'
  | 'photoshop'
  | 'canva'
  | 'website'
  | 'live-app'
  | 'pdf'
  | 'png'
  | 'jpg'
  | 'svg'

/* the tile's light: a hairline edge, a highlight along the top, a soft drop */
const APP_TILE_SHADOW =
  'inset 0 0 0 0.5px rgba(0,0,0,.1), inset 0 1px 0 rgba(255,255,255,.28), 0 1px 2px rgba(0,0,0,.12), 0 4px 10px -4px rgba(0,0,0,.22)'

/** A tile's fill and what it carries: a `glyph` drawn on the 24 grid at 56%
 *  of the side, or `art` that sizes itself (a chrome glyph, a full-bleed mark). */
type AppTile =
  { tile: string; glyph: (gradientId: string) => JSX.Element } | { tile: string; art: (side: number) => JSX.Element }

/** A chrome glyph on a tile (white unless told), at the chrome's own hairline. */
function chromeGlyph(Glyph: typeof WebIcon, color = '#fff') {
  return (side: number) => <Glyph size={Math.round(side * 0.56)} style={{ color }} />
}

/** Each tile's fill and the glyph it carries, after doop.design's "Works with" row. */
const APP_TILES: Record<AppIconBrand, AppTile> = {
  claude: { tile: CLAUDE_COLOR, glyph: () => <path fill="#fff" d={CLAUDE_PATH} /> },
  'claude-code': { tile: '#262624', glyph: () => <path fill={CLAUDE_COLOR} d={CLAUDE_PATH} /> },
  openai: { tile: '#fff', glyph: () => <path fill="#111" d={OPENAI_PATH} /> },
  gemini: {
    tile: '#fff',
    glyph: (id) => (
      <>
        <GeminiGradient id={id} />
        <path fill={`url(#${id})`} d={GEMINI_PATH} />
      </>
    ),
  },
  seedream: {
    tile: '#fff',
    glyph: (id) => (
      <>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#3C8CFF" />
            <stop offset="1" stopColor="#2BC4C9" />
          </linearGradient>
        </defs>
        <path fill={`url(#${id})`} d={BYTEDANCE_PATH} />
      </>
    ),
  },
  /* the OR is wider than tall: scaled into the 24 box and centred */
  openrouter: {
    tile: '#111',
    glyph: () => <path fill="#fff" transform="translate(0 3.52) scale(0.09375)" d={OPENROUTER_PATH} />,
  },
  /* the knot reversed out of black, beside ChatGPT's black on white */
  codex: { tile: '#111', glyph: () => <path fill="#fff" d={OPENAI_PATH} /> },
  cursor: { tile: '#14120b', glyph: () => <path fill="#fff" d={CURSOR_PATH} /> },
  /* any other MCP client: no brand of its own, so a plain tile */
  mcp: { tile: '#fff', art: chromeGlyph(PuzzleIcon, '#111') },
  /* a headless agent or server: a plain tile, like any other MCP client */
  headless: { tile: '#fff', art: chromeGlyph(ServerIcon, '#111') },
  github: { tile: '#111', glyph: () => <path fill="#fff" d={GITHUB_PATH} /> },
  /* Figma's own app icon: the five colours on near-black */
  figma: { tile: '#1e1e1e', art: (side) => <Figma size={Math.round(side * 0.56)} /> },
  /* the letters alone on Adobe's tile, at the size the app icon draws them */
  photoshop: {
    tile: '#001e36',
    art: (side) => (
      <svg width={side} height={side} viewBox="0 0 42 42" aria-hidden>
        <path fill="#31a8ff" d={PHOTOSHOP_P} />
        <path fill="#31a8ff" d={PHOTOSHOP_S} />
      </svg>
    ),
  },
  canva: {
    tile: '#fff',
    art: (side) => <img src={canvaLogo} alt="" width={Math.round(side * 0.7)} height={Math.round(side * 0.7)} />,
  },
  website: { tile: '#0177d3', art: chromeGlyph(WebIcon) },
  'live-app': { tile: '#1f9d55', art: chromeGlyph(RadioTowerIcon) },
  pdf: { tile: '#e5322d', art: chromeGlyph(PdfIcon) },
  png: { tile: '#6e56cf', art: chromeGlyph(ImageIcon) },
  jpg: { tile: '#0891b2', art: chromeGlyph(ImageIcon) },
  svg: { tile: '#d97706', art: chromeGlyph(VectorIcon) },
}

export const APP_ICON_BRANDS = Object.keys(APP_TILES) as AppIconBrand[]

/**
 * A provider, source or format as an app icon, the way doop.design shows the
 * agents it works with: the brand's tile (corners at 23% of the side) with its
 * glyph at 56%. 32px in a list row, 40px beside a modal title.
 */
export function AppIcon({ brand, size = 32, className }: { brand: AppIconBrand; size?: number; className?: string }) {
  const id = useId()
  const tile = APP_TILES[brand]
  const inner = Math.round(size * 0.56)
  return (
    <span
      aria-hidden
      className={cn('grid flex-none place-items-center overflow-hidden', className)}
      style={{ width: size, height: size, borderRadius: '23%', background: tile.tile, boxShadow: APP_TILE_SHADOW }}
    >
      {'art' in tile ? (
        tile.art(size)
      ) : (
        <svg width={inner} height={inner} viewBox="0 0 24 24">
          {tile.glyph(id)}
        </svg>
      )}
    </span>
  )
}
