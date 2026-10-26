import { z } from 'zod'
import type { LinearStep } from '../../shared/automations.ts'
import { AutomationPullError } from '../extensions.ts'
import { getConnection } from './connection.ts'
import { agentToken, getInstallation } from './oauth.ts'
import { linearQuery, LinearError } from './client.ts'

async function tokenFor(userId: string) {
  const connection = await getConnection(userId)
  if (connection) return connection.accessToken
  const installation = await getInstallation(userId)
  if (!installation) throw new AutomationPullError('Connect Linear in Integrations first.', 'reconnect')
  return agentToken(installation.organizationId)
}

export async function automationTeams(userId: string) {
  const token = await tokenFor(userId)
  const result = await linearQuery(
    token,
    'query DoopAutomationTeams { teams(first: 250) { nodes { id name key } } }',
    {},
    z.object({ teams: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string(), key: z.string() })) }) }),
  )
  return result.teams.nodes
}

export async function createAutomationIssue(step: LinearStep, ownerId: string, context: string) {
  try {
    const token = await tokenFor(ownerId)
    const result = await linearQuery(
      token,
      `mutation DoopAutomationIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { identifier url } }
      }`,
      {
        input: {
          teamId: step.teamId,
          title: step.title,
          description: [step.description, context].filter(Boolean).join('\n\n'),
        },
      },
      z.object({
        issueCreate: z.object({
          success: z.boolean(),
          issue: z.object({ identifier: z.string(), url: z.string().url() }).nullable(),
        }),
      }),
    )
    if (!result.issueCreate.success || !result.issueCreate.issue)
      throw new LinearError('Linear could not create the ticket.')
    return { summary: `Created ${result.issueCreate.issue.identifier}`, url: result.issueCreate.issue.url }
  } catch (error) {
    if (error instanceof LinearError && error.status === 409)
      throw new AutomationPullError('Reconnect Linear with permission to create issues.', 'reconnect')
    throw error
  }
}
