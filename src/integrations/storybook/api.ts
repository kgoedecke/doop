import type {
  StorybookOffer,
  StorybookRunResult,
  StorybookSourceComponent,
  StorybookSourceView,
} from '../../../shared/storybookSource'
import { req } from '../../lib/api'

/** An import or sync as the server reports it while it runs and after. */
export interface StorybookJobView {
  id: string
  state: 'running' | 'done' | 'failed'
  progress: { status: string; done: number; total: number }
  result?: StorybookRunResult
  summary?: string
  error?: string
}

export interface StorybookDiscovery {
  url: string
  components: StorybookOffer[]
  source: StorybookSourceView | null
}

const base = (canvasId: string) => `/api/canvases/${canvasId}/storybook`

export const storybookApi = {
  discover: (canvasId: string, url: string) =>
    req<StorybookDiscovery>(`${base(canvasId)}/discover`, { method: 'POST', body: JSON.stringify({ url }) }),
  importComponents: (canvasId: string, url: string, components: StorybookSourceComponent[]) =>
    req<{ job: StorybookJobView }>(`${base(canvasId)}/import`, {
      method: 'POST',
      body: JSON.stringify({ url, components }),
    }),
  sources: (canvasId: string) => req<{ sources: StorybookSourceView[] }>(`${base(canvasId)}/sources`),
  sync: (canvasId: string, sourceId: string) =>
    req<{ job: StorybookJobView }>(`${base(canvasId)}/sources/${sourceId}/sync`, { method: 'POST' }),
  remove: (canvasId: string, sourceId: string) =>
    req<{ ok: true }>(`${base(canvasId)}/sources/${sourceId}`, { method: 'DELETE' }),
  job: (canvasId: string, jobId: string) => req<{ job: StorybookJobView }>(`${base(canvasId)}/jobs/${jobId}`),
}
