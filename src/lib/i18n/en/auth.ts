/** The signed-out screens: sign-in, sign-up, password reset, OAuth consent,
 *  the desktop app's browser hand-offs, and the "view as" banner. */
export const auth = {
  networkError: 'Could not reach doop — check your connection and try again.',
  somethingWentWrong: 'Something went wrong',
  somethingWentWrongTitle: 'Something went wrong.',

  titleSignin: 'Welcome back.',
  titleSignup: 'Create your account.',
  titleForgot: 'Reset your password.',
  titleReset: 'Pick a new password.',

  forgotBlurb: 'Enter your account email and we’ll send you a reset link.',
  resetBlurb: 'Choose a new password for your account.',
  /* "A shared canvas for humans & agents. Sign in to your canvases." —
     "& agents" is set in the brand colour */
  taglineBefore: 'A shared canvas for humans',
  taglineEmphasis: '& agents',
  taglineAfter: '.',
  taglineSignin: 'Sign in to your canvases.',
  taglineSignup: 'Sign up to start designing.',

  signInWith: 'Sign in with {provider}',
  signUpWith: 'Sign up with {provider}',
  or: 'or',

  nameLabel: 'Name',
  emailLabel: 'Email',
  emailPlaceholder: 'you@example.com',
  passwordLabel: 'Password',
  newPasswordLabel: 'New password',
  passwordPlaceholder: 'At least 8 characters',
  forgotPassword: 'Forgot password?',

  signIn: 'Sign in',
  signUp: 'Sign up',
  sendResetLink: 'Send reset link',
  setNewPassword: 'Set new password',
  noAccountSignUp: 'No account yet? Sign up',
  haveAccountSignIn: 'Have an account? Sign in',
  createAccountInstead: 'Create an account instead',
  signInInstead: 'Sign in instead',
  resendVerification: 'Resend verification email',

  ssoAccountNotLinked:
    'That email already has a doop account that could not be linked automatically — sign in with email/password instead.',
  ssoEmailMismatch: "The signed-in email doesn't match the account you started from — try again.",
  ssoEmailMissing: "Your identity provider didn't share an email address — doop needs one to sign you in.",
  ssoDesktopHandoff:
    'That sign-in link has expired — start again and finish in your browser within a couple of minutes.',
  ssoFailed: 'Sign-in failed — try again or use email/password.',
  startFailed: 'Could not start sign-in — try again or use email/password.',
  browserSignInNotice: 'Finish signing in in your browser — doop signs you in here the moment you come back.',
  verificationSent: 'Verification email sent — check your inbox.',
  resetLinkSent: 'If an account exists for that email, a reset link is on its way.',
  resetLinkInvalid: 'This reset link is invalid or expired — request a new one.',
  passwordUpdated: 'Password updated — sign in with your new password.',
  emailNotVerified: 'This email hasn’t been verified yet.',
  noAccountFound: 'No account found for this email.',
  accountExists: 'An account with this email already exists.',
  verifyEmailSent: 'Almost there — we sent a verification link to {email}. Open it to activate your account.',

  consentTitle: 'Connect {name}?',
  consentTitleGeneric: 'Connect your agent',
  consentSignedInAs: 'Signed in as {email}',
  consentScope:
    'This agent will be able to read your profile and read, create, edit and delete designs on the canvases you can access. Its changes will be attributed to your account.',
  consentExpired: 'This connection request has expired. Start again from your agent.',
  consentLoadFailed: 'Could not load the connection.',
  consentFinishFailedRetry: 'Could not finish connecting. Start again from your agent.',
  consentFinishFailed: 'Could not finish connecting.',
  connecting: 'Connecting…',
  connect: 'Connect',

  desktopLinkIncomplete: 'This sign-in link is incomplete — go back to the doop app and try again.',
  desktopStartFailed: 'Could not start sign-in — go back to the doop app and try again.',
  desktopSigningIn: 'Signing you in…',
  desktopToProvider: 'Taking you to your identity provider for the doop app.',
  desktopSignedIn: "You're signed in.",
  desktopHandoffFailed: 'Could not hand the sign-in over to the doop app. Go back to the app and try again.',
  desktopSendingBack: 'Sending you back to the doop app… You can close this tab afterwards.',
  openDoop: 'Open doop',
  desktopConnectTitle: 'Back to the doop app.',
  desktopConnectBody:
    'Doop finishes connecting in the app, for the account signed in there. You can close this tab afterwards.',
  desktopConnectFailed: 'Could not hand the connection over to the doop app. Go back to the app and try again.',

  /* "Viewing as <name> — read only, expires after 15 minutes." */
  viewingAsBefore: 'Viewing as',
  viewingAsAfter: '— read only, expires after 15 minutes.',
  stopViewing: 'Stop viewing',
  leaving: 'Leaving…',
} as const
