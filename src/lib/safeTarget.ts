/** Only ever follow a same-origin relative path taken from a query param or
 *  a deep link. A naive startsWith('/') check passes both "//evil.com"
 *  (protocol-relative — the browser resolves it against the current
 *  protocol, landing on a different origin) and "/\evil.com" (browsers
 *  normalize the backslash to a second slash for http(s) URLs, same bypass)
 *  — resolving against an origin and checking the result stayed on it catches
 *  both. Any origin works for that, so a fixed one keeps this free of
 *  browser globals. */
const BASE = 'https://relative.invalid'

export function safeRelativeTarget(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith('/')) return null
  try {
    return new URL(raw, BASE).origin === BASE ? raw : null
  } catch {
    return null
  }
}
