import { z } from 'zod'

export class LinearError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message)
  }
}

/** Never forward upstream error text: it can contain request or credential details. */
export async function linearQuery<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  let response: Response
  try {
    response = await fetch(process.env.LINEAR_API_URL || 'https://api.linear.app/graphql', {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    throw new LinearError('Could not reach Linear. Try again.')
  }
  const body = await response.json().catch(() => null)
  const envelope = z
    .object({
      data: z.unknown().optional(),
      errors: z
        .array(
          z.object({ extensions: z.object({ code: z.string().optional() }).passthrough().optional() }).passthrough(),
        )
        .optional(),
    })
    .safeParse(body)
  const codes = envelope.success ? envelope.data.errors?.map((error) => error.extensions?.code) : []
  if (
    response.status === 401 ||
    response.status === 403 ||
    codes?.includes('AUTHENTICATION_ERROR') ||
    codes?.includes('FORBIDDEN')
  ) {
    throw new LinearError('Linear rejected this key. Reconnect with a valid key that has read access.', 409)
  }
  if (response.status === 429 || codes?.includes('RATELIMITED')) {
    throw new LinearError('Linear rate limit reached. Try again later.', 429)
  }
  if (!response.ok || !envelope.success || envelope.data.errors?.length) {
    throw new LinearError('Linear could not complete this request.')
  }
  const parsed = schema.safeParse(envelope.data.data)
  if (!parsed.success) throw new LinearError('Linear returned an unexpected response.')
  return parsed.data
}

const named = z.object({ id: z.string(), name: z.string() })
const issue = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  priority: z.number(),
  updatedAt: z.string(),
  state: named.extend({ type: z.string() }),
  team: named.extend({ key: z.string() }),
  assignee: named.nullable(),
  project: named.nullable(),
})
const fields =
  'id identifier title url priority updatedAt state { id name type } team { id name key } assignee { id name } project { id name }'

export const listIssuesInput = z.object({
  team_key: z.string().trim().min(1).max(100).optional(),
  assignee_id: z.string().trim().min(1).max(100).optional(),
  state_type: z.enum(['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled']).optional(),
  first: z.number().int().min(1).max(50).default(25),
  after: z.string().min(1).max(1000).optional(),
})

export function listIssues(token: string, input: z.input<typeof listIssuesInput>) {
  const { team_key, assignee_id, state_type, first, after } = listIssuesInput.parse(input)
  const filter = {
    ...(team_key ? { team: { key: { eq: team_key } } } : {}),
    ...(assignee_id ? { assignee: { id: { eq: assignee_id } } } : {}),
    state: { type: state_type ? { eq: state_type } : { nin: ['completed', 'canceled'] } },
  }
  return linearQuery(
    token,
    `query DoopIssues($filter: IssueFilter, $first: Int!, $after: String) {
      issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
        nodes { ${fields} }
        pageInfo { hasNextPage endCursor }
      }
    }`,
    { filter, first, after },
    z.object({
      issues: z.object({
        nodes: z.array(issue),
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
      }),
    }),
  )
}

export function getIssue(token: string, id: string) {
  return linearQuery(
    token,
    `query DoopIssue($id: String!) { issue(id: $id) { ${fields} description } }`,
    { id },
    z.object({ issue: issue.extend({ description: z.string().nullable() }).nullable() }),
  )
}
