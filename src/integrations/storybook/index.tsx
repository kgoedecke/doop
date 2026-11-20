import type { ClientIntegration, SettingsCardProps } from '../index'
import { AppIcon } from '@/components/ui/brand-mark'
import { Note } from '../../components/ui/note'
import { IntegrationCard } from '../ui'
import { StorybookImportSection } from './StorybookImport'

function StorybookTile({ size = 36, className }: { size?: number; className?: string }) {
  return <AppIcon brand="storybook" size={size} className={className} />
}

/* Nothing to connect: a published Storybook is read where it is, a private one through the
   CLI with an agent key. The card says where the import lives. */
function StorybookSettingsCard(_props: SettingsCardProps) {
  return (
    <IntegrationCard
      tile={<StorybookTile />}
      name="Storybook"
      detail="Your components, with variants, tokens and fonts"
      connected={null}
      footnote="On a canvas: Import → Storybook"
      actions={null}
    >
      <Note size="sm" className="block text-ink-soft">
        Import from any published Storybook, and sync again when it changes. For one on localhost or behind a VPN, the
        import shows a CLI command that runs where your Storybook does.
      </Note>
    </IntegrationCard>
  )
}

/** Everything the pages need to know about the Storybook import — its one line in
 *  `src/integrations/index.tsx` mounts all of it. Spec: .context/specs/storybook-import.md. */
export const storybookIntegration: ClientIntegration = {
  id: 'storybook',
  name: 'Storybook',
  Tile: StorybookTile,
  importSource: {
    title: 'Storybook',
    blurb: 'Your real components, kept in sync.',
    icon: <AppIcon brand="storybook" />,
  },
  disconnectCopy: 'automations.disconnect',
  /* nothing to connect: always ready */
  isConnected: () => true,
  disconnect: () => Promise.reject(new Error('Storybook has nothing to disconnect')),
  SettingsCard: StorybookSettingsCard,
  ImportSection: StorybookImportSection,
}
