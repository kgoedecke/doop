/* Session replay + exception capture + web vitals are compiled into our
   bundle (instead of posthog-js lazy-loading them from PostHog's CDN at
   runtime), and the no-external build guarantees nothing else is remotely
   loaded. Combined with the same-origin /relay proxy this makes analytics
   first-party end to end: there is no PostHog-owned URL for blockers to
   match, so replay works for effectively every user.

   posthog-recorder (not the legacy dist/recorder) is required: the SDK only
   starts replay when the entrypoint registers BOTH __PosthogExtensions__
   .rrweb and .initSessionRecording, and the legacy recorder lacks the
   latter — replay then waits on a lazy load that the no-external build can
   never perform and every session sticks at $recording_status
   "lazy_loading". */
import 'posthog-js/dist/posthog-recorder'
import 'posthog-js/dist/exception-autocapture'
import 'posthog-js/dist/web-vitals'
/* Conversations (customer support widget): also a lazy-loaded extension, so
   it must be compiled in or the no-external build can never show it. */
import 'posthog-js/dist/conversations'
import posthog from 'posthog-js/dist/module.no-external'
import { installFrameReplay } from './frameReplay'
import { desktopPlatform, isDesktopShell, shellVersion } from './shell'

const key = import.meta.env.VITE_POSTHOG_KEY
/* Default to the same-origin relay (server/index.ts); VITE_POSTHOG_HOST is an
   escape hatch for pointing elsewhere, e.g. straight at PostHog in a dev
   setup without the API server. */
const host = import.meta.env.VITE_POSTHOG_HOST || `${location.origin}/relay`

/* Both keys are inlined at build time, so a build that never saw them ships an
   app with analytics silently off. Warn rather than throw: a missing key must
   not white-screen a fresh clone that hasn't copied .env.example yet. */
/* Accounts on "internal" email domains are excluded from session replay:
   the operators' own usage would drown out real-user recordings. Domains
   come from VITE_POSTHOG_INTERNAL_DOMAINS (comma-separated, inlined at
   build time); unset = no exclusions. The runtime stop covers the session
   where the login happens; the persisted flag keeps replay from even
   starting on that browser's next load. */
const INTERNAL_DOMAINS: string[] = (import.meta.env.VITE_POSTHOG_INTERNAL_DOMAINS || '')
  .split(',')
  .map((d: string) => d.trim().toLowerCase())
  .filter(Boolean)
const isInternalEmail = (email: string) => INTERNAL_DOMAINS.some((d) => email.toLowerCase().endsWith(`@${d}`))
const NO_REPLAY_KEY = 'doop:internal-no-replay'

if (!key) {
  console.warn('VITE_POSTHOG_KEY is unset — PostHog is disabled and no events will be sent.')
} else {
  installFrameReplay()
  posthog.init(key, {
    api_host: host,
    /* api_host is our relay; links out to the PostHog app must not be */
    ui_host: 'https://us.posthog.com',
    capture_pageview: 'history_change',
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
    session_recording: {
      recordCrossOriginIframes: true,
      /* a design tool: what people type into prompts/comments is the point
         of watching a replay. Credentials stay masked. */
      maskAllInputs: false,
      maskInputOptions: { password: true, email: true },
    },
    disable_session_recording: localStorage.getItem(NO_REPLAY_KEY) === '1',
    defaults: '2026-05-30',
  })

  /* The desktop shell marks every page it loads (src/lib/shell.ts). Register
     the shell version and platform as super properties so every event and
     recording from the shell is segmentable in PostHog. The webview's
     storage is isolated from the user's browsers, so the flag can never
     leak onto ordinary web sessions. */
  if (isDesktopShell()) {
    posthog.register({
      desktop_app: true,
      desktop_app_version: shellVersion(),
      desktop_app_platform: desktopPlatform(),
    })
  }
}

/** Call on every identify: stops replay for internal accounts, (re)starts it
 *  when a non-internal account signs in on a browser previously flagged. */
export function syncReplayForUser(email: string | null | undefined) {
  if (!key || !email) return
  if (isInternalEmail(email)) {
    localStorage.setItem(NO_REPLAY_KEY, '1')
    posthog.stopSessionRecording()
  } else {
    localStorage.removeItem(NO_REPLAY_KEY)
    /* explicit start overrides disable_session_recording from init */
    posthog.startSessionRecording()
  }
}

/** An admin viewing as another user. Their navigation must not be written to
 *  the customer's PostHog profile, and must not be recorded at all.
 *
 *  Deliberately does NOT go through syncReplayForUser: that function keys the
 *  persisted NO_REPLAY_KEY flag off the account email, so a borrowed email
 *  would rewrite whose browser this is — an internal operator viewing as an
 *  external user would clear their own exclusion and keep recording after the
 *  support session ended. */
export function suspendAnalyticsWhileImpersonating() {
  if (!key) return
  posthog.reset() // subsequent events are anonymous, not the customer's
  posthog.stopSessionRecording()
}

/* The Support widget (PostHog Conversations, switched on in the project
   settings for doop.design) floats in the bottom-right corner, where it sits
   on the editor's zoom bar and the prompt bar. It is for the pages around the
   editor, not the canvas itself. The SDK renders it only after the remote
   config arrives, and hide() before that is a no-op, so the wish is kept and
   re-applied the moment the widget's container is mounted. */
const WIDGET_CONTAINER_ID = 'ph-conversations-widget-container'
let supportWidgetWanted = true
let supportWidgetObserver: MutationObserver | null = null
let cancelSupportChat: (() => void) | null = null

const applySupportWidget = () => {
  if (!key || !posthog.conversations?.isAvailable()) return
  if (supportWidgetWanted || cancelSupportChat) posthog.conversations.show()
  else posthog.conversations.hide()
}

export function setSupportWidgetVisible(visible: boolean) {
  cancelSupportChat?.()
  supportWidgetWanted = visible
  applySupportWidget()
  if (!key || supportWidgetObserver || typeof MutationObserver === 'undefined') return
  supportWidgetObserver = new MutationObserver((mutations) => {
    if (supportWidgetWanted || cancelSupportChat) return
    const mounted = mutations.some((m) =>
      Array.from(m.addedNodes).some((n) => n instanceof Element && n.id === WIDGET_CONTAINER_ID),
    )
    if (mounted) applySupportWidget()
  })
  supportWidgetObserver.observe(document.body, { childList: true })
}

/* "Contact support" from the editor: show the widget and open its chat
   panel. The SDK has no open(): show() restores the saved panel state, so
   click the launcher if it mounts closed. On a canvas
   the bubble is otherwise hidden, so when the person closes the panel (the
   launcher returns) the widget goes back out of the way. */
const LAUNCHER = `#${WIDGET_CONTAINER_ID} button[aria-label^="Open chat"]`
const CLOSE_CHAT = `#${WIDGET_CONTAINER_ID} button[aria-label="Close"]`
export function openSupportChat() {
  if (!key || !posthog.conversations?.isAvailable()) return false
  if (cancelSupportChat) return true
  let frame = 0
  let closed: MutationObserver | null = null
  // Override the canvas's mount observer before show() adds the widget.
  cancelSupportChat = () => {
    cancelAnimationFrame(frame)
    closed?.disconnect()
    cancelSupportChat = null
  }
  const finish = () => {
    cancelSupportChat?.()
    applySupportWidget()
  }
  const started = Date.now()
  const open = () => {
    const launcher = document.querySelector<HTMLButtonElement>(LAUNCHER)
    if (!launcher && !document.querySelector(CLOSE_CHAT)) {
      if (Date.now() - started < 3000) frame = requestAnimationFrame(open)
      else finish()
      return
    }
    launcher?.click()
    const container = document.getElementById(WIDGET_CONTAINER_ID)
    if (!container) {
      finish()
      return
    }
    closed = new MutationObserver(() => {
      if (!document.querySelector(LAUNCHER)) return
      finish()
    })
    closed.observe(container, { childList: true, subtree: true })
  }
  posthog.conversations.show()
  frame = requestAnimationFrame(open)
  return true
}

export { posthog }
