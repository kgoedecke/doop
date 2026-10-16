import express from 'express'
import type { ServerExtension } from '../extensions.ts'
import { agentEnabled, finishInstall, getInstallation, startInstall } from './oauth.ts'
import { disconnectAgent, startSlackWorker } from './jobs.ts'
import { slackWebhookRouter } from './webhook.ts'
import { SlackError } from './client.ts'

export const slackExtension: ServerExtension = {
  id: 'slack',
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
  connectRouter: ({ respondWithStatus }) => {
    const router = express.Router()
    router.post('/start', async (req, res, next) => {
      try {
        res.json(await startInstall(req.user!.id))
      } catch (error) {
        if (error instanceof SlackError) return res.status(error.status).json({ error: error.message })
        next(error)
      }
    })
    router.get('/callback', async (req, res) => {
      try {
        await finishInstall(req.user!.id, String(req.query.state ?? ''), String(req.query.code ?? ''))
        res.redirect('/integrations?slack=connected')
      } catch (error) {
        const message = error instanceof SlackError ? error.message : 'Could not install Doop in Slack.'
        res.redirect(`/integrations?slackError=${encodeURIComponent(message)}`)
      }
    })
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
