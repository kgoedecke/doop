import type { Meta, StoryObj } from '@storybook/react-vite'
import { AuthCard, AuthCardText, AuthScreen } from '@/components/ui/screen'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { CodeBlock } from '@/components/ui/code-block'
import { Disclosure } from '@/components/ui/collapsible'
import { InstallBlock } from '@/components/ui/install-block'

/**
 * The pieces whole screens and flows are built from: the signed-out card
 * (sign-in, OAuth consent, the desktop hand-offs, a missing canvas) and the
 * agent install block the Connect AI flows share.
 */
const meta = { title: 'Screens' } satisfies Meta
export default meta

type Story = StoryObj<typeof meta>

/** AuthCard inside AuthScreen: the wordmark and a DashTitle, then the screen's own copy and actions. */
export const SignedOutCard: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <AuthScreen className="h-auto min-h-0">
        <AuthCard title="Connect Claude Code?">
          <AuthCardText className="break-all">Signed in as ada@example.com</AuthCardText>
          <AuthCardText>
            This agent will be able to read your profile and read, create, edit and delete designs on the canvases you
            can access.
          </AuthCardText>
          <div className="flex justify-end gap-2">
            <Button>Cancel</Button>
            <Button variant="solid">Connect</Button>
          </div>
        </AuthCard>
      </AuthScreen>
      <AuthScreen className="h-auto min-h-0">
        <AuthCard title="Something went wrong.">
          <Callout tone="error">
            Could not hand the sign-in over to the doop app. Go back to the app and try again.
          </Callout>
        </AuthCard>
      </AuthScreen>
      <AuthScreen className="h-auto min-h-0">
        <AuthCard title="Canvas not found" align="center">
          <AuthCardText>“c1x9” doesn’t match a canvas we know about.</AuthCardText>
          <Button className="self-center">Back to your canvases</Button>
        </AuthCard>
      </AuthScreen>
    </div>
  ),
}

/** InstallBlock: the action, a status or error line under it, and the manual steps folded away. */
export const Install: Story = {
  render: () => (
    <div className="flex max-w-[420px] flex-col gap-8">
      <InstallBlock
        action={<Button variant="solid">Add to Codex</Button>}
        manual={<CodeBlock text="codex mcp add doop --url https://doop.design/mcp" />}
      />
      <InstallBlock
        action={<Button variant="solid">Added to Codex</Button>}
        status="Doop is configured. Open a new Codex chat, then sign in to Doop when prompted."
        manual={<CodeBlock text="codex mcp add doop --url https://doop.design/mcp" />}
      />
      <InstallBlock
        action={<Button variant="solid">Add to Claude</Button>}
        error="Install Claude Desktop first."
        manualLabel="Install manually"
        manual={<p>Download the extension, then open it with Claude Desktop.</p>}
      />
    </div>
  ),
}

/** Disclosure: the `<details>` replacement, folded and unfolded. */
export const Disclosures: Story = {
  render: () => (
    <div className="flex max-w-[420px] flex-col gap-4 text-label text-ink-soft">
      <Disclosure label="Connection help">
        <p>Use Customize → Connectors → Add custom connector with this address.</p>
      </Disclosure>
      <Disclosure label="Connection help" defaultOpen>
        <p>Use Customize → Connectors → Add custom connector with this address.</p>
      </Disclosure>
    </div>
  ),
}
