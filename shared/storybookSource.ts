/**
 * A Storybook a canvas imports from, as the server keeps it and the import section shows it.
 * Spec: .context/specs/storybook-import.md, "Sync".
 */

/** A component picked from the Storybook, and what it became on the canvas. */
export interface StorybookSourceComponent {
  /** the story title, `Components/Button`: what it is known by across syncs */
  title: string
  /** a story other than the one the import picks by itself */
  storyId?: string
  /** a selector for the part of the story that is the component */
  select?: string
  /** the Doop component it became */
  componentId?: string
  /** what it was built to last time: an unchanged build is not sent again */
  hash?: string
  fontRenames?: Record<string, string>
}

export type StorybookComponentOutcome = 'created' | 'updated' | 'unchanged' | 'skipped' | 'failed'

export interface StorybookComponentResult {
  title: string
  name: string
  outcome: StorybookComponentOutcome
  componentId?: string
  /** share of the story's pixels the component draws the same, 0-1 */
  fidelity?: number
  /** what the agent or person should hear: notes from the build and from Doop's checks */
  notes: string[]
}

export interface StorybookRunResult {
  at: number
  components: StorybookComponentResult[]
  tokens: { created: string[]; updated: string[]; leftAlone: string[] }
  fonts: { added: string[]; notes: string[] }
  /** a reason the run as a whole stopped */
  error?: string
}

export interface StorybookSourceView {
  id: string
  canvasId: string
  url: string
  components: StorybookSourceComponent[]
  lastResult: StorybookRunResult | null
  createdAt: number
  syncedAt: number | null
}

/** A component the Storybook offers, as the picker lists it. */
export interface StorybookOffer {
  title: string
  name: string
  stories: number
  codePath?: string
}

export const STORYBOOK_WORKER = 'Storybook Import'

/** Below this share of matching pixels the import says the component draws unlike its story. */
export const FIDELITY_WARNING = 0.9
export const MAX_STORYBOOK_COMPONENTS = 60
