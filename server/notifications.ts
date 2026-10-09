import { Router } from 'express'
import { z } from 'zod'
import { mailerConfigured } from './mailer.ts'
import { getNotificationPrefs, saveNotificationPrefs } from './notificationPrefs.ts'
import type { NotificationPrefs, NotificationSettings } from '../shared/notifications.ts'

/** /api/notifications: the settings page's view of a user's notification switches. */

export const notificationsRouter = Router()

const prefsSchema = z.object({ commentEmails: z.boolean() })

function settings(prefs: NotificationPrefs): NotificationSettings {
  return { ...prefs, emailConfigured: mailerConfigured }
}

notificationsRouter.get('/', (req, res, next) => {
  getNotificationPrefs(req.user!.id)
    .then((prefs) => res.json(settings(prefs)))
    .catch(next)
})

notificationsRouter.put('/', (req, res, next) => {
  const parsed = prefsSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid notification preference' })
    return
  }
  saveNotificationPrefs(req.user!.id, parsed.data)
    .then(() => res.json(settings(parsed.data)))
    .catch(next)
})
