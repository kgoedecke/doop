import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Field } from '@/components/ui/field'
import { Checkbox, CheckboxCard } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import { NumberField, ColorField } from '@/components/ui/property-field'
import { CircleDashedIcon } from '@/components/ui/icons'
import { SearchField } from '@/components/ui/search-field'

const meta = { title: 'Primitives/Fields' } satisfies Meta
export default meta

type Story = StoryObj<typeof meta>

export const Inputs: Story = {
  render: () => (
    <div className="flex max-w-[420px] flex-col gap-5">
      <Field label="Canvas name" hint="Shown in the tab and on the home tiles." htmlFor="f1">
        <Input id="f1" placeholder="Untitled canvas" />
      </Field>
      <Field label="Website URL" labelVariant="form" htmlFor="f2">
        <Input id="f2" variant="mono" inputSize="lg" placeholder="https://example.com" />
      </Field>
      <Field label="Plain label" labelVariant="plain" htmlFor="f3">
        <Input id="f3" inputSize="sm" placeholder="Small field" />
      </Field>
      <Field label="Brief" htmlFor="f4">
        <Textarea id="f4" rows={3} placeholder="What should the agent design?" />
      </Field>
    </div>
  ),
}

/** `variant="well"`: the filled field of a modal or form, paper inside a hairline, no focus glow. */
export const Wells: Story = {
  render: () => (
    <div className="flex max-w-[420px] flex-col gap-5">
      <Input variant="well" placeholder="Invite by email (doop account)" aria-label="Invite by email" />
      <Input
        variant="well"
        inputSize="lg"
        className="font-mono"
        placeholder="https://figma.com/design/…"
        aria-label="Figma link"
      />
      <Textarea
        variant="well"
        rows={2}
        placeholder="What is this design? One or two lines helps people find it."
        aria-label="Description"
      />
    </div>
  ),
}

/** `variant="code"`: the HTML editor's dark well, the same in both themes. */
export const CodeEditor: Story = {
  name: 'Textarea (code)',
  render: () => (
    <Textarea
      variant="code"
      className="h-[160px] max-w-[420px]"
      aria-label="Frame HTML"
      spellCheck={false}
      defaultValue={'<!doctype html>\n<html>\n  <body>\n    <h1>Pricing</h1>\n  </body>\n</html>'}
    />
  ),
}

/** The ring field the home list uses: no border, a 1px ring. Variants under Primitives/Controls. */
export const Search: Story = {
  name: 'Search field (ring)',
  render: () => <SearchField className="w-[220px]" placeholder="Search canvases" aria-label="Search canvases" />,
}

function CheckboxDemo() {
  const [on, setOn] = useState(true)
  return (
    <div className="flex max-w-[420px] flex-col gap-4">
      <label className="flex items-center gap-2.5 text-body">
        <Checkbox checked={on} onChange={(e) => setOn(e.target.checked)} /> Extract the design system too
      </label>
      <CheckboxCard
        checked={!on}
        onChange={(checked) => setOn(!checked)}
        title="Pricing page"
        description="3 frames · edited 2d ago"
      />
    </div>
  )
}

export const Checkboxes: Story = { render: () => <CheckboxDemo /> }

export const ProgressBar: Story = {
  name: 'Progress',
  render: () => (
    <div className="flex max-w-[240px] flex-col gap-3">
      <Progress value={3} max={10} aria-label="Free tasks left" />
      <span className="text-caption text-ink-faint">3 of 10 free tasks left.</span>
    </div>
  ),
}

export const InspectorFields: Story = {
  render: function InspectorFields() {
    const [x, setX] = useState(24)
    const [rotation, setRotation] = useState(0)
    const [color, setColor] = useState<string | null>('#0177d3')
    return (
      <div className="flex w-[220px] flex-col gap-2">
        <NumberField label="X position" prefix="X" value={x} unit="" onCommit={setX} />
        <NumberField
          label="Rotation"
          prefix={<CircleDashedIcon size="rail" />}
          value={rotation}
          unit="°"
          onCommit={setRotation}
        />
        <NumberField label="Disabled position" prefix="Y" value={0} unit="" disabled onCommit={() => {}} />
        <ColorField label="Fill color" value={color} onCommit={setColor} />
      </div>
    )
  },
}
