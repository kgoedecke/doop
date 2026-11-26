import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { ErrorFallback } from '@/components/ui/error-boundary'
import { Panel } from '@/components/ui/panel'
import { Button } from '@/components/ui/button'

const meta = { title: 'Primitives/ErrorBoundary' } satisfies Meta
export default meta

type Story = StoryObj<typeof meta>

/** What a part of the page that failed to draw shows in its place. */
export const Fallback: Story = {
  render: () => <ErrorFallback retry={() => {}} className="w-fit" />,
}

function Fragile({ broken }: { broken: boolean }) {
  if (broken) throw new Error('A panel read a frame it did not expect')
  return <p className="p-4 text-body text-ink">The panel draws normally.</p>
}

/** Every `Panel` holds a boundary: break its content, then fix it and Retry. */
export const InAPanel: Story = {
  render: function Render() {
    const [broken, setBroken] = useState(false)
    return (
      <div className="flex w-[264px] flex-col gap-4">
        <Button size="sm" className="self-start" onClick={() => setBroken((b) => !b)}>
          {broken ? 'Fix the panel' : 'Break the panel'}
        </Button>
        <Panel className="relative h-40">
          <Fragile broken={broken} />
        </Panel>
      </div>
    )
  },
}
