/** Per-user notification switches, as the settings page reads and writes them. */
export interface NotificationPrefs {
  /** email on new comments and replies on canvases you collaborate on */
  commentEmails: boolean
}

/** What GET /api/notifications returns: the switches plus whether this
 *  instance can send email at all, so the UI can say why a switch is inert. */
export interface NotificationSettings extends NotificationPrefs {
  emailConfigured: boolean
}
