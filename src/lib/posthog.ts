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
import posthog from 'posthog-js/dist/module.no-external'

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
      /* a design tool: what people type into prompts/comments is the point
         of watching a replay. Credentials stay masked. */
      maskAllInputs: false,
      maskInputOptions: { password: true, email: true },
    },
    disable_session_recording: localStorage.getItem(NO_REPLAY_KEY) === '1',
    defaults: '2026-05-30',
  })

  /* The desktop shell injects window.__DOOP_DESKTOP__ = "<shell version>"
     before any page script runs (desktop/src-tauri/src/main.rs). Register it
     as super properties so every event and recording from the shell is
     segmentable in PostHog. The webview's storage is isolated from the
     user's browsers, so the flag can never leak onto ordinary web sessions. */
  const desktopVersion = (window as { __DOOP_DESKTOP__?: unknown }).__DOOP_DESKTOP__
  if (typeof desktopVersion === 'string') {
    posthog.register({ desktop_app: true, desktop_app_version: desktopVersion })
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

export { posthog }
