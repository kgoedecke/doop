import type { ComponentType, ReactNode } from 'react'
import type { IntegrationsStatus } from '../lib/api'
import { linearIntegration } from './linear'

/**
 * Client extensions, the mirror of `server/extensions.ts`: each integration
 * ships its own card for the Integrations page and (optionally) its section
 * in the canvas import modal. The pages iterate `clientIntegrations` and
 * never name an integration — removing one from a build is deleting its
 * folder and its line in the list below.
 */

export interface SettingsCardProps {
  status: IntegrationsStatus
  busy: boolean
  setBusy(busy: boolean): void
  setStatus(status: IntegrationsStatus): void
  showToast(message: string): void
  /** open the shared "Disconnect …?" confirm; the page calls `disconnect` */
  requestDisconnect(): void
}

export interface ImportSectionProps {
  canvasId: string
  /** swap the modal to a review view (null returns to this screen) */
  setReview(view: ReactNode | null): void
  /** the import started and runs on as a task — close the modal */
  onImporting(frameCount: number): void
  /** return to the source picker */
  onBack(): void
}

interface ClientIntegrationBase {
  id: string
  name: string
  /** the integration's mark on a paper tile (step chains, list rows) */
  Tile?: ComponentType<{ size?: number; className?: string }>
  /** its card in the import modal's source picker (with `ImportSection`) */
  importSource?: { title: string; blurb: string; icon: ReactNode }
  /** body copy of the shared disconnect confirm dialog */
  disconnectCopy: string
  isConnected(status: IntegrationsStatus): boolean
  disconnect(): Promise<IntegrationsStatus>
  SettingsCard: ComponentType<SettingsCardProps>
  ImportSection?: ComponentType<ImportSectionProps>
}

/** An automation-capable integration must bring its own tile — step chains
 *  and list rows would otherwise have nothing honest to show for it. */
export type ClientIntegration =
  | (ClientIntegrationBase & { automationPull?: undefined })
  | (ClientIntegrationBase & {
      Tile: ComponentType<{ size?: number; className?: string }>
      automationPull: {
        /** the add-step tile's line, e.g. "Import what's new in a Figma file." */
        blurb: string
        /** what a pull lands, e.g. "Frames" */
        subtitle: string
        placeholder: string
        /** the source field on the step ('url' for Figma) */
        field: 'url'
      }
    })

export const clientIntegrations: ClientIntegration[] = [linearIntegration]
