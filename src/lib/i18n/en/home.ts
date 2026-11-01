/** Home: the hero and composer, the canvas list, the workspace dialogs and the agent allowance. */
export const home = {
  /* header */
  manage: 'Manage',
  import: 'Import',
  newCanvas: 'New canvas',
  newShort: 'New',

  /* failures and toasts */
  createCanvasFailed: 'Couldn’t create the canvas',
  startCanvasFailed: 'Couldn’t start the canvas',
  startImportFailed: 'Couldn’t start the import',
  briefNotQueued: 'The brief didn’t queue — try sending it again',
  duplicateFailed: 'Couldn’t duplicate canvas',
  shareFailed: 'Couldn’t open sharing',
  linkCopied: 'Canvas link copied',
  movedTo: 'Moved to {name}',
  movedToFallback: 'the workspace',
  movedToPersonal: 'Moved to Personal',

  /* upgrade reasons */
  reasonAddCanvas: 'Adding a canvas to a workspace needs a Team plan.',
  reasonMoveCanvas: 'Moving a canvas into a workspace needs a Team plan.',
  reasonWorkspaceReady: '"{name}" is ready — pick a plan to start using it.',

  /* scopes */
  ownedByMe: 'Owned by me',
  sharedWithMe: 'Shared with me',
  allCanvases: 'All canvases',

  /* a workspace without a plan */
  noPlanTitle: '{name} has no plan yet.',
  noPlanAskOwner: 'Ask the owner to choose one — until then no canvases can be added here.',
  noPlanChoose: 'Choose a Team plan to add canvases and invite your team.',
  choosePlan: 'Choose a plan',

  /* list header */
  people: { one: '{count} person', other: '{count} people' },
  teamPlan: 'Team plan',
  sharedWorkspace: 'Shared workspace',
  noPlanYet: 'No plan yet',
  sortAria: 'Sort: {label}',
  sortUpdated: 'Last edited',
  sortName: 'Name',
  sortCreated: 'Newest',
  viewAria: 'View',
  gridView: 'Grid view',
  listView: 'List view',

  /* list body */
  emptyTitle: 'Start your first canvas',
  emptyDescription:
    'A canvas is a shared space of live HTML frames — you design in the browser, your AI agents design through MCP, and everyone watches everything happen in real time.',
  createCanvas: '+ Create a canvas',
  nothingHere: 'Nothing here yet — try another scope.',
  createNewCanvasAria: 'Create a new canvas',
  frames: { one: '{count} frame', other: '{count} frames' },

  /* delete */
  deleteTitle: 'Delete “{name}”?',
  deleteFallbackName: 'canvas',
  deleteDescription: 'This permanently deletes the canvas and everything in it. This can’t be undone.',
  deleteConfirm: 'Delete canvas',

  /* tile meta */
  claimTitle: 'This canvas predates accounts and is visible to everyone. Claim it to make it yours.',
  claimBadge: 'unclaimed — make mine',
  sharedByTitle: 'You were invited to collaborate on this canvas',
  sharedBy: 'Shared by {name}',
  edited: 'Edited {time}',
  inWorkspace: 'In the {workspace} workspace',

  /* canvas actions */
  actionsFor: 'Actions for {name}',
  share: 'Share',
  duplicating: 'Duplicating…',
  duplicate: 'Duplicate',
  move: 'Move…',
  moveToWorkspace: 'Move to workspace…',

  /* hero */
  greeting: 'Ask me what to design',
  chipLanding: 'Draft a landing page',
  chipLandingPrompt: 'Draft a landing page for ',
  chipRecap: 'Recap a session',
  chipRecapPrompt: 'Recap what happened on my canvases this week, as one summary frame.',
  chipChanged: 'What changed',
  chipChangedPrompt: 'What changed across my canvases this week?',
  chipAutomation: 'Run an automation',
  chipAgents: 'Connect your agents',
  chipImport: 'Import a design',
  chipComments: 'Review comments',
  chipCommentsPrompt: 'Go through the open comments on my canvases and address each one.',
  composerPlaceholder: 'What changed across my canvases this week?',
  composerAria: 'Ask Doop what to design',
  attachTitle: 'Attach a design to start from',
  files: 'Files',
  draftsAria: 'Drafts per prompt: {count}',
  drafts: { one: '{count} draft', other: '{count} drafts' },
  draftsCaption: 'Drafts per prompt',
  draftsDescription: { one: 'One take on the brief', other: '{count} takes, side by side, to pick from' },
  send: 'Send',
  connectDesigns: 'Connect your existing designs for better results',

  /* agent allowance */
  meterGeminiCloud: 'Doop Agent on your Gemini cloud connection',
  meterClaudeLocal: 'Doop Agent on your local Claude CLI',
  meterChatgpt: 'Doop Agent on your ChatGPT',
  meterProviderKey: 'Doop Agent on your {provider} key',
  meterNoFreeTier: 'Connect a plan in Settings to use the Doop Agent',
  meterUsedUp: 'Free Doop Agent tasks used up — connect ChatGPT to continue',
  meterUsedUpLine: 'free Doop Agent tasks used up — connect ChatGPT to continue',
  meterLeft: {
    one: '{left} of {count} free Doop Agent task left',
    other: '{left} of {count} free Doop Agent tasks left',
  },
  wallUsedUpTitle: 'Your free Doop Agent tasks are used up',
  wallConnectTitle: 'Connect a plan to use the Doop Agent',
  wallUsedUpBefore: 'Those were on the house. Connect your',
  wallUsedUpBold: 'ChatGPT subscription',
  wallUsedUpAfter:
    'and the Doop Agent keeps working exactly as it does now — same canvas, same agent, running on your plan instead of ours.',
  wallConnectBefore: 'The Doop Agent designs on your canvases using a subscription you already have. Connect',
  wallConnectAfter: 'once and every task runs on your plan — nothing metered, no separate bill.',
  wallConnectButton: 'Connect your plan',
  wallMcp:
    'Prefer to drive the canvas yourself from Claude Code, Codex, or another MCP client? That agent designs as you prompt it — queued tasks stay with the Doop Agent.',
  wallMcpLink: 'See how to connect it',

  /* create a workspace */
  workspacesEyebrow: 'Workspaces',
  nameWorkspace: 'Name your workspace',
  createWorkspaceLede:
    'A workspace is your team’s shared home: everyone in it can open every canvas inside. You can move existing canvases in afterwards.',
  workspaceNameAria: 'Workspace name',
  creating: 'Creating…',
  createWorkspace: 'Create workspace',
  createWorkspaceFailed: 'Couldn’t create the workspace',

  /* the upgrade wall */
  upgradeEyebrow: 'Team plan · {price} per seat per month',
  plansFor: 'Plans for {name}',
  unlock: 'Unlock {name}',
  plans: 'Plans',
  upgradeDefaultReason: 'Shared workspaces are the paid part of doop.',
  upgradeLede:
    'Everyone in a workspace opens every canvas in it — no per-canvas invites, no links to pass around. Seats are billed as people join and refunded as they leave.',
  billingOff: 'Billing isn’t set up on this server, so workspaces are included. Nothing to buy — go make one.',
  monthly: 'Monthly',
  yearly: 'Yearly',
  yearlyPrice: '{perMonth} a seat a month, billed {perYear} a year',
  monthlyPrice: '{price} a seat, billed monthly',
  seats: { one: '{count} seat × {price}', other: '{count} seats × {price}' },
  totalPerMonth: '= {total} per month',
  totalPerYear: '= {total} per year',
  alreadyOnTeam: ' — already on Team; manage it from Billing.',
  countingSeats: 'Counting seats…',
  stripeNote: 'You’ll set up payment on Stripe’s secure checkout. Cancel any time from the billing portal.',
  askOwnerBefore: 'Ask',
  askOwnerAfter: 'to choose a plan — the owner holds the billing.',
  workspaceOwnerFallback: 'the workspace owner',
  openingStripe: 'Opening Stripe…',
  continueCheckout: 'Continue to checkout',
  checkoutFailed: 'Couldn’t start checkout',
  receipts: 'Receipts go to {email}. Need invoicing, SSO or a bigger team?',
  talkToUs: 'Talk to us',
  receiptsEnd: '.',
  popular: 'Popular',
  current: 'Current',
  letsTalk: 'Let’s talk',
  perSeatMonth: '/ seat / month',
  billedYearly: 'billed {price} a seat yearly',
  contactUs: 'Contact us',

  /* move a canvas */
  moveTitle: 'Move “{name}”',
  moveLede:
    'A canvas in a workspace is open to everyone in it. Move it back to Personal and only you and the people you invited keep access.',
  destinationAria: 'Destination',
  personalOption: 'Personal — just you and invitees',
  needsPlanSuffix: ' (needs a plan)',
  targetNoPlan: '{name} has no plan yet — you’ll be asked to choose one.',
  moving: 'Moving…',
  moveCanvas: 'Move canvas',
  moveFailed: 'Couldn’t move the canvas',
} as const
