import { describe, expect, it } from 'vitest'
import { browserPlatform } from '../src/lib/desktopDownload'

const UA = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  chromeos:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
}

describe('browserPlatform', () => {
  it('names the three desktop systems', () => {
    expect(browserPlatform({ userAgent: UA.mac }, 0)).toBe('macos')
    expect(browserPlatform({ userAgent: UA.windows }, 0)).toBe('windows')
    expect(browserPlatform({ userAgent: UA.linux }, 0)).toBe('linux')
  })

  it('prefers client hints when the browser sends them', () => {
    expect(browserPlatform({ userAgent: UA.mac, userAgentData: { platform: 'Windows', mobile: false } }, 0)).toBe(
      'windows',
    )
  })

  it('offers nothing to phones, tablets or ChromeOS', () => {
    expect(browserPlatform({ userAgent: UA.android }, 5)).toBeNull()
    expect(browserPlatform({ userAgent: UA.iphone }, 5)).toBeNull()
    expect(browserPlatform({ userAgent: UA.chromeos }, 0)).toBeNull()
    // an iPad asks for the desktop site with a Mac user agent
    expect(browserPlatform({ userAgent: UA.mac }, 5)).toBeNull()
    expect(browserPlatform({ userAgent: UA.windows, userAgentData: { mobile: true } }, 0)).toBeNull()
  })
})
