/**
 * Case-insensitive search for an ASCII needle (a tag name such as `<doop-use`), run on the
 * string itself. Searching a lowercased copy instead gives offsets into a different string:
 * "İ" (U+0130) lowercases to two code units, so every offset after one points a character
 * past the match in the original, and a Turkish frame stopped expanding its instances there.
 */

const fold = (code: number) => (code >= 65 && code <= 90 ? code + 32 : code)

function matchesAt(haystack: string, needle: string, at: number): boolean {
  for (let i = 0; i < needle.length; i++) {
    if (fold(haystack.charCodeAt(at + i)) !== needle.charCodeAt(i)) return false
  }
  return true
}

/** `needle` must be lowercase ASCII. */
export function indexOfAscii(haystack: string, needle: string, from = 0): number {
  for (let at = Math.max(0, from); at + needle.length <= haystack.length; at++) {
    if (matchesAt(haystack, needle, at)) return at
  }
  return -1
}

/** `needle` must be lowercase ASCII. */
export function lastIndexOfAscii(haystack: string, needle: string, from = haystack.length): number {
  for (let at = Math.min(from, haystack.length - needle.length); at >= 0; at--) {
    if (matchesAt(haystack, needle, at)) return at
  }
  return -1
}
