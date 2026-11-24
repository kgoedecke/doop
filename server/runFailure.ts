/** How much of a provider's or the CLI's error a card shows. */
const MAX_DETAIL = 400

/**
 * The readable part of what made a run fail, for the card the person sees:
 * when the text carries a provider's JSON error body (the first `{` or `[`
 * from which the rest parses as JSON), that body's `message`, after the words
 * before it minus a bare status code; otherwise the text itself. Whitespace
 * collapsed, capped. Empty when there is nothing to say.
 */
export function failureDetail(raw: string): string {
  let text = raw.trim()
  const body = jsonBody(text)
  if (body) {
    const before = text
      .slice(0, body.at)
      .trim()
      .replace(/^\d{3}$/, '')
    text = [before, body.message].filter(Boolean).join(' ')
  }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text
}

/** How many brackets are tried as a body's start: a summary full of them
 *  must not cost a parse per bracket. */
const MAX_BODY_TRIES = 8

/** The first `{` or `[` from which the rest of the text is one JSON value
 *  holding a `message`, with that message. */
function jsonBody(text: string): { at: number; message: string } | undefined {
  let tries = 0
  for (let at = text.search(/[[{]/); at >= 0 && tries < MAX_BODY_TRIES; at = nextBracket(text, at + 1), tries++) {
    let value: unknown
    try {
      value = JSON.parse(text.slice(at))
    } catch {
      continue
    }
    const message = messageIn(value, 0)
    return message ? { at, message } : undefined
  }
  return undefined
}

function nextBracket(text: string, from: number): number {
  const rest = text.slice(from).search(/[[{]/)
  return rest < 0 ? -1 : from + rest
}

/** `message` on the value, its `error`, or the first entry of an array. */
function messageIn(value: unknown, depth: number): string | undefined {
  if (depth > 3 || !value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) return messageIn(value[0], depth + 1)
  const record = value as Record<string, unknown>
  if (typeof record.message === 'string' && record.message.trim()) return record.message
  return messageIn(record.error, depth + 1)
}

/** The card's reason for a run that crashed: what went wrong in the
 *  connection's own words when we have them, else the generic retry line. */
export function crashReason(agent: string, source: string, detail: string | undefined): string {
  const said = detail ? failureDetail(detail) : ''
  if (!said) return `${agent} hit a snag before finishing. Retry when you are ready.`
  return `${agent} could not finish. ${source} said: “${said}” Retry when you are ready.`
}
