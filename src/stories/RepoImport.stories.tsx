import type { Meta, StoryObj } from '@storybook/react-vite'
import { Modal } from '@/components/ui/modal'
import { RepoAgentGuide, type RepoGuideState } from '@/components/RepoAgentGuide'

/**
 * A GitHub repo import for someone with no Doop Agent plan: first who should
 * build it, then the person's own agent opened with the prompt filled in.
 */
const meta = { title: 'Flows/Repo import' } satisfies Meta
export default meta

type Story = StoryObj<typeof meta>

function Guide({ state }: { state: RepoGuideState }) {
  return (
    <Modal size="xl" className="sm:max-w-[820px]" onClose={() => {}}>
      <RepoAgentGuide
        canvasId="HvmSUEFsg-"
        repo="CreateNewCo/cn_website"
        state={state}
        onConnectAgent={() => {}}
        onAgentConnected={() => {}}
        onClose={() => {}}
      />
    </Modal>
  )
}

/** Nobody can build it yet: a plan, or an agent of their own. */
export const WhoBuildsIt: Story = { render: () => <Guide state={{ stage: 'connect' }} /> }

/** Their own agent is Claude Code: a deep link plus the terminal command. */
export const ClaudeCode: Story = {
  render: () => <Guide state={{ stage: 'agent', cardIds: [], client: 'Claude Code (doop)' }} />,
}

/** Their own agent is Claude (the connector). */
export const Claude: Story = { render: () => <Guide state={{ stage: 'agent', cardIds: [], client: 'Claude' }} /> }

/** An agent with no deep link: the prompt to paste. */
export const OtherAgent: Story = { render: () => <Guide state={{ stage: 'agent', cardIds: [], client: 'opencode' }} /> }
