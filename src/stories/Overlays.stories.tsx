import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { Modal, ModalActions, ModalEyebrow, ModalLede, ModalTitle } from '@/components/ui/modal'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/ui/field'
import {
  DropdownMenu,
  DropdownMenuCaption,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { MenuButton } from '@/components/ui/menu-button'
import { CopyIcon, ShareIcon, TrashIcon } from '@/components/ui/icons'

const meta = { title: 'Primitives/Overlays' } satisfies Meta
export default meta

type Story = StoryObj<typeof meta>

function ModalDemo() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>Name a workspace</Button>
      {open && (
        <Modal size="sm" showClose onClose={() => setOpen(false)}>
          <ModalEyebrow>Workspaces</ModalEyebrow>
          <ModalTitle className="mt-2">Name your workspace</ModalTitle>
          <ModalLede>A workspace is your team’s shared home: everyone in it can open every canvas inside.</ModalLede>
          <Field label="Name" labelVariant="form" htmlFor="ws" className="mt-5">
            <Input id="ws" placeholder="Acme design" autoFocus />
          </Field>
          <ModalActions>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => setOpen(false)}>
              Create workspace
            </Button>
          </ModalActions>
        </Modal>
      )}
    </>
  )
}

export const ModalStory: Story = { name: 'Modal', render: () => <ModalDemo /> }

function ConfirmDemo() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        Delete canvas
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete “Pricing page”?"
        description="This permanently deletes the canvas and everything in it. This can’t be undone."
        confirmLabel="Delete canvas"
        destructive
        onConfirm={() => setOpen(false)}
      />
    </>
  )
}

export const Confirm: Story = { name: 'Confirm dialog', render: () => <ConfirmDemo /> }

export const SheetStory: Story = {
  name: 'Sheet',
  render: () => (
    <Sheet>
      <SheetTrigger asChild>
        <Button>Open sheet</Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Getting started</SheetTitle>
          <SheetDescription>Connect your own agent, or give the Doop Agent a task.</SheetDescription>
        </SheetHeader>
      </SheetContent>
    </Sheet>
  ),
}

/** sm for a short list of verbs, md for rows with a sub-line, lg for a name plus an email or a blurb. */
function DropdownDemo() {
  const [sort, setSort] = useState('updated')
  const [drafts, setDrafts] = useState('3')
  return (
    <div className="flex items-start gap-5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <MenuButton aria-label="Canvas actions">Actions</MenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" width="sm">
          <DropdownMenuItem>
            <ShareIcon className="size-4" /> Share
          </DropdownMenuItem>
          <DropdownMenuItem>
            <CopyIcon className="size-4" /> Duplicate
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem tone="danger">
            <TrashIcon className="size-4" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <MenuButton aria-label={`Sort: ${sort}`}>Sort</MenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" width="sm">
          <DropdownMenuRadioGroup value={sort} onValueChange={setSort}>
            <DropdownMenuRadioItem value="updated">Last edited</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="created">Newest</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <MenuButton variant="quiet" icon={<CopyIcon width={14} height={14} />} aria-label={`Drafts: ${drafts}`}>
            {drafts} drafts
          </MenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" width="md">
          <DropdownMenuCaption>Drafts per prompt</DropdownMenuCaption>
          <DropdownMenuRadioGroup value={drafts} onValueChange={setDrafts}>
            <DropdownMenuRadioItem value="1" description="One take on the brief">
              1 draft
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="3" description="3 takes, side by side, to pick from">
              3 drafts
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <MenuButton aria-label="Model">Model</MenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" width="lg">
          <DropdownMenuCaption>Doop Agent model</DropdownMenuCaption>
          <DropdownMenuItem description="The everyday workhorse. A good default for design work">
            GPT-5.6 Terra
          </DropdownMenuItem>
          <DropdownMenuItem description="Fastest and cheapest — fine for small, mechanical edits">
            GPT-5.6 Luna
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export const Dropdown: Story = { name: 'Dropdown menu', render: () => <DropdownDemo /> }
