import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { XIcon } from '@/components/ui/icons'

const meta = { title: 'Primitives/Popover', component: PopoverContent } satisfies Meta<typeof PopoverContent>
export default meta
type Story = StoryObj<typeof meta>

export const LeftEditor: Story = {
  render: () => (
    <div className="flex min-h-80 justify-end p-8">
      <Popover>
        <PopoverTrigger asChild>
          <Button>Image</Button>
        </PopoverTrigger>
        <PopoverContent side="left" align="start" aria-label="Image settings">
          <div className="flex h-10 items-center justify-between border-b border-line-soft px-3">
            <span className="font-medium">Image</span>
            <PopoverClose asChild>
              <Button variant="bare" size="icon-sm" aria-label="Close image settings">
                <XIcon size="rail" />
              </Button>
            </PopoverClose>
          </div>
          <div className="p-3">
            <Input inputSize="sm" aria-label="Image URL" placeholder="https://…" />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  ),
}
