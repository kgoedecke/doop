/** /settings: its rail, pane headings and the Appearance pane. */
export const settings = {
  sectionLabel: 'Settings',
  backToCanvases: 'Back to canvases',
  backToCanvas: 'Back to canvas',
  canvases: 'Canvases',
  canvas: 'Canvas',

  agentTitle: 'Doop Agent',
  agentBlurb: 'Which model account the agent runs on, for every canvas you work on.',
  keysTitle: 'Agent keys',
  keysBlurb: 'Bearer credentials that let headless agents design as you.',
  webhooksTitle: 'Webhooks',
  webhooksBlurb: 'HTTP calls to your systems when something happens on a canvas you can open.',
  accountTitle: 'Your account',
  accountTab: 'Account',
  accountBlurb: 'Who you are on every canvas, and how you get back into this one.',
  appearanceTitle: 'Appearance',
  appearanceBlurb:
    'How Doop looks in this browser: light or dark, the language it speaks, and how the canvas editor lays out its panels.',

  agentCardDescription:
    'Choose how the Doop Agent runs on your canvases: a connected model account or Claude CLI on your desktop. Your provider’s usage limits and charges apply.',
  freeTasksLeftLabel: 'Free Doop Agent tasks left',
  meterGeminiCloud: 'Gemini cloud pilot selected. Connection managed by your operator.',
  meterClaudeLocal: 'Claude CLI selected. It runs on your connected desktop.',
  meterChatgpt: 'Running on your ChatGPT subscription.',
  meterProviderKey: 'Running on your {provider} key.',
  meterNoFreeTasks: 'No free tasks on this server. Connect an account to use the Doop Agent.',
  meterUsedUp: 'Your free tasks are used up.',
  meterLeft: { one: '{left} of {count} free task left.', other: '{left} of {count} free tasks left.' },

  themeTitle: 'Theme',
  themeDescription:
    'Light or dark, across every canvas and page in this browser. System follows your operating system and switches whenever it does.',
  themeRow: 'Appearance',
  themeAria: 'Theme',
  themeSystem: 'System',
  themeLight: 'Light',
  themeDark: 'Dark',
  themeFollowingSystem: 'Following your system ({resolved} right now).',
  themeResolvedLight: 'light',
  themeResolvedDark: 'dark',
  themeSetByHand: 'Set by hand, so your system setting is ignored.',

  languageTitle: 'Language',
  languageDescription:
    'The language Doop’s screens are written in, in this browser. Until you pick one, you see the default this server is set to.',
  languageRow: 'Language',
  languageAria: 'Language',
  languagePicked: 'Picked in this browser.',
  languageServerDefault: 'The server’s default. Pick one to keep it in this browser.',

  panelsTitle: 'Canvas panels',
  panelsDescription:
    'How the canvas editor lays out Layers, the inspector and Agents in this browser. Floating panels hover over the canvas; docked panels sit flush against the window’s edges, with the canvas between them.',
  panelsRow: 'Layout',
  panelsAria: 'Canvas panels',
  panelsFloating: 'Floating',
  panelsDocked: 'Docked',
  panelsFloatingNote: 'Panels float over the canvas.',
  panelsDockedNote: 'Panels are docked to the edges.',
} as const
