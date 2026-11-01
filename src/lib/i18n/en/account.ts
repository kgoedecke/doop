/** The "Your account" pane of /settings: profile, notifications, password. */
export const account = {
  nameSaveFailed: 'That name could not be saved',
  nameSaved: 'Saved. Agents pick it up within a minute',
  passwordChangeFailed: 'That password could not be changed',
  passwordUpdated: 'Password updated. Every other session was signed out',
  notifySaveFailed: 'That could not be saved. Try again',
  verificationSendFailed: 'That email could not be sent',
  verificationSent: 'Verification email sent',

  profileTitle: 'Profile',
  profileDescription:
    'Your name is the identity shown on cursors, in the activity feed, and on everything you leave for an agent. Agents see the change within a minute.',
  nameRow: 'Name',
  saving: 'Saving…',
  displayNameAria: 'Display name',
  nameUnsaved: 'Changed, not saved yet',
  emailRow: 'Email',
  emailNotChangeable: 'Sign-in address (not changeable yet)',
  resendVerification: 'Resend verification',
  verified: 'verified',
  unverified: 'unverified',

  notificationsTitle: 'Notifications',
  notificationsDescription:
    'Email about what happens on your canvases while you are not looking at them. Your own comments never trigger one.',
  commentEmailsRow: 'Comment emails',
  commentEmailsAria: 'Email me about new comments and replies',
  commentEmailsLabel:
    'New comments and replies on canvases you own, were invited to, or wrote in, bundled into one email per canvas every couple of minutes.',
  emailNotConfigured: 'This doop has no email set up (SMTP_HOST), so nothing is sent either way.',

  passwordTitle: 'Password',
  passwordDescription: 'Changing it signs out every other browser and device. This one stays signed in.',
  currentPassword: 'Current password',
  newPassword: 'New password',
  updatingPassword: 'Updating…',
  updatePassword: 'Update password',
  passwordMinLength: 'At least 8 characters',
} as const
