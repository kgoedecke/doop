import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

/**
 * The component-layer `no-restricted-syntax` rule in eslint.config.js: every
 * banned pattern is reported once, and the named scale, tokens and
 * Pressable-free markup it steers people to pass. Linted as a file under
 * src/pages, which nothing exempts.
 */

const eslint = new ESLint()

async function errorsFor(jsx: string): Promise<number> {
  const code = `export const Probe = ({ on }: { on: boolean }) => (\n  <div>\n    ${jsx}\n  </div>\n)\n`
  const [result] = await eslint.lintText(code, { filePath: 'src/pages/LintProbe.tsx' })
  return result?.messages.filter((m) => m.ruleId === 'no-restricted-syntax').length ?? 0
}

describe('component-layer lint rule', () => {
  it.each([
    ['raw button', '<button />'],
    ['stock type size', '<p className="text-sm" />'],
    ['stock type size behind a variant', '<p className="md:text-2xl" />'],
    ['stock type size in a template literal', '<p className={`x ${on ? "text-lg" : ""}`} />'],
    ['stock radius', '<p className="rounded-lg" />'],
    ['stock side radius', '<p className="rounded-t-md" />'],
    ['bare rounded', '<p className="rounded" />'],
    ['arbitrary leading', '<p className="leading-[1.4]" />'],
    ['arbitrary tracking', '<p className="tracking-[0.1em]" />'],
    ['bold', '<p className="font-bold" />'],
    ['arbitrary weight', '<p className="font-[650]" />'],
    ['hex background', '<p className="bg-[#fff]" />'],
    ['hex text colour', '<p className="text-[#fff]" />'],
    ['arbitrary text size', '<p className="text-[13px]" />'],
    ['arbitrary radius', '<p className="rounded-[3px]" />'],
    ['role="button"', '<div role="button" />'],
    ['role="link"', '<span role="link" />'],
    ["role={'button'}", "<div role={'button'} />"],
    ['role={`link`}', '<span role={`link`} />'],
  ])('reports %s', async (_name, jsx) => {
    expect(await errorsFor(jsx)).toBe(1)
  })

  it('passes the named scale, shapes, tokens and other roles', async () => {
    const ok =
      '<p className="text-body/4 rounded-full rounded-row rounded-control text-smoke font-semibold leading-none text-left bg-brand" />' +
      '<div role="status" /><div role={"dialog"} />'
    expect(await errorsFor(ok)).toBe(0)
  })
})
