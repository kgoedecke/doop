/** The agent team card (Settings → Doop Agent, Workspace → Agents). */
export const agents = {
  title: 'Agent team',
  descriptionWorkspace: 'The Doop Agent team on every canvas in this workspace.',
  descriptionPersonal: 'The Doop Agent team on the canvases in your personal space.',
  descriptionRest:
    'Switch off the built-in agents you do not need, change how they work, or add your own. People reach an agent by @mentioning it in a comment or in the prompt box, and automations can hand it a step.',
  builtIn: 'Built in',
  builtInNote:
    'An agent that is off leaves the mention list and the automation steps; work waiting on it goes to Doop.',
  off: 'Off',
  edited: 'Edited',
  toggle: 'Use {name}',
  defaultStaysOn: 'Doop stays on: work addressed to no one goes to it.',
  builtInLede:
    'Change how this built-in agent works for this team. Your instructions replace the ones it ships with; Reset brings those back.',
  reset: 'Reset to default',
  yours: 'Custom',
  loading: 'Loading…',
  count: { one: '{count} custom agent', other: '{count} custom agents' },
  full: 'The team is full at {count} custom agents. Remove one to add another.',
  add: 'Add agent',
  edit: 'Edit',
  remove: 'Remove',
  emptyTitle: 'No custom agents yet',
  emptyPersonal:
    'Add a specialist the built-in team does not have, such as an SEO reviewer or your brand’s voice, and @mention it on your personal canvases.',
  emptyWorkspace:
    'Add a specialist the built-in team does not have, such as an SEO reviewer or your brand’s voice, and everyone in the workspace can @mention it.',
  reviewerBadge: 'Review pass: may finish without changing anything',
  loadFailed: 'The custom agents could not be loaded.',
  removeFailed: 'The agent could not be removed. Try again.',
  saveFailed: 'The agent could not be saved. Try again.',
  removeTitle: 'Remove {name}?',
  removeDescription:
    'It stops answering @mentions and leaves the automation step picker. Work still waiting on it goes to Doop, and what it already did stays.',
  addTitle: 'Add a custom agent',
  editTitle: 'Edit {name}',
  formLede: 'A specialist on the Doop Agent team. Its instructions are added to the agent’s prompt whenever it runs.',
  name: 'Name',
  namePlaceholder: 'SEO Reviewer',
  fixedHint: 'The name and handle stay as they are: open comments and cards point at them.',
  handle: 'Handle',
  blurb: 'One-line description',
  blurbPlaceholder: 'Titles, headings and meta copy for search',
  brief: 'Instructions',
  briefPlaceholder:
    'You are the SEO reviewer. Check that every page has one clear h1, descriptive headings in order, and copy that names what the page is about…',
  briefHint:
    '{used} / {max} characters. Say what it owns, what it checks and what it must leave alone. Type / to name a skill it applies on every run.',
  color: 'Colour',
  reviewer: 'Review pass',
  reviewerHint:
    'It judges existing work and may finish without an edit when the frame already meets its bar. Leave off for an agent that makes things.',
  save: 'Save',
  create: 'Add agent',
  saving: 'Saving…',
} as const
