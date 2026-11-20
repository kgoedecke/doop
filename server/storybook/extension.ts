import type { ServerExtension } from '../extensions.ts'
import { storybookCanvasRouter } from './routes.ts'
import { registerStorybookMcpTools } from './mcpTool.ts'

/** Everything the core needs to know about the Storybook import — its one line in
 *  `server/extensions.ts` mounts all of it. Spec: .context/specs/storybook-import.md. */
export const storybookExtension: ServerExtension = {
  id: 'storybook',
  canvasRouter: storybookCanvasRouter,
  registerMcpTools: registerStorybookMcpTools,
  mcpGuideLines: [
    '- Storybook: when the human points at their Storybook (or asks to design with "our components"), call list_storybook_components with its URL, then import_storybook with the titles that matter, so their real components land as Doop components with variants, tokens and fonts. Compose screens from those with <doop-use>; sync_storybook brings them up to date later.',
  ],
}
