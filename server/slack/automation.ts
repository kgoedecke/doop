import type { SlackStep } from '../../shared/automations.ts'
import { AutomationPullError } from '../extensions.ts'
import { getInstallation } from './oauth.ts'
import { postedMessage, slackApi, SlackError } from './client.ts'

export async function postAutomationMessage(step: SlackStep, ownerId: string, context: string) {
  const installation = await getInstallation(ownerId)
  if (!installation) throw new AutomationPullError('Connect Slack in Integrations first.', 'reconnect')
  try {
    await slackApi(
      installation.botToken,
      'chat.postMessage',
      {
        channel: step.channelId,
        text: [step.message, context].filter(Boolean).join('\n\n'),
        mrkdwn: false,
        parse: 'none',
        unfurl_links: false,
        unfurl_media: false,
      },
      postedMessage,
    )
    return { summary: 'Posted to Slack' }
  } catch (error) {
    if (error instanceof SlackError) {
      if (error.status === 409) throw new AutomationPullError(error.message, 'reconnect')
      if (['not_in_channel', 'channel_not_found', 'no_permission'].includes(error.code ?? ''))
        throw new Error('Check the Slack channel ID and invite @Doop to that channel.', { cause: error })
    }
    throw error
  }
}
