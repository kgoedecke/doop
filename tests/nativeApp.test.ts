// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  APP_STORE_URL,
  IOS_PROMPT_SNOOZE_MS,
  desktopCardDismissed,
  dismissNativeApp,
  iosPromptSnoozed,
  nativeAppPlatform,
  nativeAppUrl,
} from '../src/lib/nativeApp'

/**
 * The browser suggests Doop's native app for the device it runs on: the
 * desktop app on a computer, the App Store listing on an iPhone or iPad,
 * nothing where no app exists or inside the desktop app itself.
 */

const UA = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  android:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36',
  chromebook:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
}

describe('nativeAppPlatform', () => {
  afterEach(() => {
    delete (globalThis as { __DOOP_DESKTOP__?: unknown }).__DOOP_DESKTOP__
  })

  it('names the desktop platform from the user agent', () => {
    expect(nativeAppPlatform({ userAgent: UA.mac, maxTouchPoints: 0 })).toBe('macos')
    expect(nativeAppPlatform({ userAgent: UA.windows })).toBe('windows')
    expect(nativeAppPlatform({ userAgent: UA.linux })).toBe('linux')
  })

  it('takes an iPhone, and an iPad asking for the desktop site, for iOS', () => {
    expect(nativeAppPlatform({ userAgent: UA.iphone, maxTouchPoints: 5 })).toBe('ios')
    expect(nativeAppPlatform({ userAgent: UA.mac, maxTouchPoints: 5 })).toBe('ios')
  })

  it('offers nothing on Android, ChromeOS or inside the desktop app', () => {
    expect(nativeAppPlatform({ userAgent: UA.android })).toBeNull()
    expect(nativeAppPlatform({ userAgent: UA.chromebook })).toBeNull()
    ;(globalThis as { __DOOP_DESKTOP__?: unknown }).__DOOP_DESKTOP__ = '0.12.0'
    expect(nativeAppPlatform({ userAgent: UA.mac })).toBeNull()
  })

  it('links each platform to its download', () => {
    expect(nativeAppUrl('ios')).toBe(APP_STORE_URL)
    expect(nativeAppUrl('macos')).toBe('https://doop.design/download/mac')
    expect(nativeAppUrl('windows')).toBe('https://doop.design/download/windows')
    expect(nativeAppUrl('linux')).toBe('https://doop.design/download/linux')
  })
})

describe('dismissals', () => {
  afterEach(() => localStorage.clear())

  it('hides the desktop card for good', () => {
    expect(desktopCardDismissed()).toBe(false)
    dismissNativeApp('card')
    expect(desktopCardDismissed()).toBe(true)
  })

  it('snoozes the iOS sheet for a fortnight, independently of the card', () => {
    dismissNativeApp('ios', 1_000)
    expect(iosPromptSnoozed(1_000 + IOS_PROMPT_SNOOZE_MS - 1)).toBe(true)
    expect(iosPromptSnoozed(1_000 + IOS_PROMPT_SNOOZE_MS)).toBe(false)
    expect(desktopCardDismissed()).toBe(false)
  })

  it('reads a corrupt record as nothing dismissed', () => {
    localStorage.setItem('doop:native-app-promo', '{nope')
    expect(desktopCardDismissed()).toBe(false)
    expect(iosPromptSnoozed()).toBe(false)
  })
})
