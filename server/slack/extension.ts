import express from 'express'
import type { ServerExtension } from '../extensions.ts'
import { agentEnabled, finishInstall, getInstallation, startInstall } from './oauth.ts'
import { disconnectAgent, startSlackWorker } from './jobs.ts'
import { slackWebhookRouter } from './webhook.ts'
import { SlackError } from './client.ts'
import { postAutomationMessage } from './automation.ts'

export const slackExtension: ServerExtension = {
  id: 'slack',
  runAutomationAction: (step, ctx) => {
    if (step.type !== 'slack') throw new Error('Expected a Slack step')
    return postAutomationMessage(step, ctx.ownerId, ctx.context)
  },
  webhookRouter: slackWebhookRouter,
  startWorker: startSlackWorker,
  connectionStatus: async (userId) => {
    const installation = await getInstallation(userId)
    return {
      connected: !!installation,
      agentConfigured: agentEnabled(),
      workspaceName: installation?.name,
      connectedAt: installation?.connectedAt,
    }
  },
  oauth: {
    start: async (userId) => (await startInstall(userId)).url,
    finish: async (userId, query) => {
      try {
        await finishInstall(userId, query.state ?? '', query.code ?? '')
        return '/integrations?slack=connected'
      } catch (error) {
        const message = error instanceof SlackError ? error.message : 'Could not install Doop in Slack.'
        return `/integrations?slackError=${encodeURIComponent(message)}`
      }
    },
  },
  connectRouter: ({ respondWithStatus }) => {
    const router = express.Router()
    router.delete('/', async (req, res, next) => {
      try {
        await disconnectAgent(req.user!.id)
        await respondWithStatus(req, res)
      } catch (error) {
        next(error)
      }
    })
    return router
  },
}
