/** The "Webhooks" pane of /settings: registering, testing and rotating hooks. */
export const webhooks = {
  healthOff: 'off, so nothing is sent',
  healthNoDeliveries: 'no deliveries yet',
  healthFailing: {
    one: '{count} failed in a row · last {when}: {error}',
    other: '{count} failed in a row · last {when}: {error}',
  },
  healthFailed: 'failed',
  healthDelivered: 'delivered {when} (HTTP {status})',

  eventCommentCreated: 'A comment is left on an element',
  eventCommentReplied: 'A reply lands in a comment thread',
  eventCommentResolved: 'A comment thread is resolved',
  eventFrameCreated: 'A frame is created',
  eventTaskCompleted: 'An agent finishes a board card',
  eventTaskFailed: 'An agent fails a board card',

  loadFailed: 'Your webhooks could not be loaded',
  createFailed: 'That webhook could not be created',
  pingAnswered: 'ping answered with HTTP {status}',
  pingFailed: 'ping failed: {error}',
  pingNoResponse: 'no response',
  testFailed: 'The test could not be sent',
  toggleFailed: 'That could not be saved',
  rotateFailed: 'The secret could not be rotated',
  removeFailed: 'That webhook could not be removed',

  title: 'Webhooks',
  descriptionBefore:
    'doop POSTs a signed JSON event to each URL below when something happens on a canvas you own, were invited to, or that lives in one of your workspaces. Route it to Slack, n8n, an issue tracker, anything with an HTTP endpoint. Each delivery carries an ',
  descriptionAfter:
    ' header (HMAC-SHA256 with the webhook’s secret) so the receiver can trust it. Failed deliveries are retried three times; a hook that keeps failing pauses itself.',
  newWebhookRow: 'New webhook',
  adding: 'Adding…',
  addWebhook: 'Add webhook',
  urlAria: 'Webhook URL',

  signingSecretRow: 'Signing secret',
  copyNow: 'Copy it now: it is shown once. Verify deliveries with it on your side.',
  signatureFormula:
    'signature = “sha256=” + HMAC-SHA256(secret, X-Doop-Timestamp + “.” + raw body). The docs have a ready-made check.',

  sendTest: 'Send test',
  rotateSecret: 'Rotate secret',
  turnOff: 'Turn off',
  turnOn: 'Turn on',
  removeAria: 'Remove webhook for {host}',
  remove: 'Remove',
  noWebhooksRow: 'No webhooks yet',
  noWebhooksNote: 'Add one above. A quick way to try it is an n8n Webhook node or a request bin.',

  rotateConfirmTitle: 'Rotate the secret for {host}?',
  removeConfirmTitle: 'Remove the webhook for {host}?',
  rotateConfirmDescription: 'Deliveries signed with the old secret stop verifying.',
  removeWebhook: 'Remove webhook',
} as const
