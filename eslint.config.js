import tseslint from 'typescript-eslint'

/* Screens compose primitives from src/components/ui; they do not draw their
   own buttons, fields or sizes. The dashboard surfaces (Home, the rail, the
   search palette, Automations, Settings, Community, Integrations) are on the
   component layer and the rule below holds them there. The files listed here
   are the canvas editor's chrome and the modals around it, which have not
   been migrated yet (a separate pass): they are exempt until that pass takes
   each one off this list. Add nothing new here. */
const LEGACY_CHROME = [
  /* the canvas editor and its panels */
  'src/pages/CanvasPage.tsx',
  'src/components/ActivityPanel.tsx',
  'src/components/Board.tsx',
  'src/components/CanvasComments.tsx',
  'src/components/CanvasDrawing.tsx',
  'src/components/CodePanel.tsx',
  'src/components/CommentPopovers.tsx',
  'src/components/CommentsPanel.tsx',
  'src/components/Cursors.tsx',
  'src/components/DesktopTabs.tsx',
  'src/components/ElementPanel.tsx',
  'src/components/FlowOverlay.tsx',
  'src/components/FollowFrame.tsx',
  'src/components/FrameView.tsx',
  'src/components/GhostFrames.tsx',
  'src/components/Inspector.tsx',
  'src/components/LayersPanel.tsx',
  'src/components/LivePresence.tsx',
  'src/components/MemoryPanel.tsx',
  'src/components/PagesPanel.tsx',
  'src/components/PathEditor.tsx',
  'src/components/PeerAvatars.tsx',
  'src/components/PromptBar.tsx',
  'src/components/SideRail.tsx',
  'src/components/Stage.tsx',
  'src/components/TopBar.tsx',
  'src/components/WorkingNow.tsx',
  'src/components/ZoomControls.tsx',
  /* the modals and flows that open over the editor */
  'src/components/ConnectModal.tsx',
  'src/components/CursorInstall.tsx',
  'src/components/ExportModal.tsx',
  'src/components/FrameExportModal.tsx',
  'src/components/FrameHistoryModal.tsx',
  'src/components/ImportSources.tsx',
  'src/components/LocalClaude.tsx',
  'src/components/Onboarding.tsx',
  /* the automation editor */
  'src/pages/AutomationEditor.tsx',
  /* settings panes and the signed-out screens: small, next in line */
  'src/components/ModelAccount.tsx',
  'src/components/TeamAllowance.tsx',
  'src/pages/Admin.tsx',
  'src/pages/AuthPage.tsx',
  'src/pages/DesktopHandoff.tsx',
  'src/pages/DesktopSignIn.tsx',
  'src/pages/Workspace.tsx',
]

const COMPONENT_LAYER_MESSAGE =
  'Compose the primitives in src/components/ui (Button, IconButton, Pressable, Input, SearchField, Textarea, Select…) instead of a raw element.'
const TYPE_SCALE_MESSAGE =
  'Use the named type scale (text-micro … text-display) and corner shapes (rounded-row/control/pill/card/panel) from .context/DESIGN.md, not an arbitrary size.'
const STOCK_TYPE_MESSAGE =
  "Use the named type scale (text-micro … text-display) from .context/DESIGN.md, not Tailwind's stock sizes: text-xs is text-label or text-caption, text-sm is text-body or text-copy, text-lg is text-lead or text-heading."
const STOCK_RADIUS_MESSAGE =
  "Use the named corner shapes (rounded-row/control/pill/card/panel) from .context/DESIGN.md, not Tailwind's stock radii (rounded, rounded-sm/md/lg/xl)."
const LINE_MESSAGE =
  'Each step of the type scale carries its own line height and tracking; drop leading-[…] and tracking-[…] (a leading modifier such as text-body/4 is the one adjustment, per .context/DESIGN.md).'
const WEIGHT_MESSAGE =
  'Use 400 for text and font-medium for labels, buttons and emphasis; font-semibold is for card and modal headings only, and nothing goes heavier (.context/DESIGN.md).'
const COLOUR_MESSAGE =
  'Use a colour token (bg-line, text-ink-soft, bg-brand, bg-success, border-line…) from .context/DESIGN.md, not a hex value: tokens flip with the theme.'
const ROLE_MESSAGE =
  'Use Pressable (or Button / IconButton) from src/components/ui instead of role="button" or role="link" on a plain element: it brings the keyboard handling and the focus ring.'

/* One class-name pattern, matched in string literals and in template-literal
   chunks alike (className strings, cn() and cva() arguments). The prefix lets
   a variant (`md:`, `hover:`, `[&>svg]:`) or Tailwind's `!` sit before the
   utility. esquery reads a regex up to the next slash, so patterns avoid `/`. */
function classSelectors(pattern, message) {
  const regex = `/(^|[\\s:!])${pattern}/`
  return [
    { selector: `Literal[value=${regex}]`, message },
    { selector: `TemplateElement[value.cooked=${regex}]`, message },
  ]
}

/* a stock utility name ends at whitespace, a modifier slash, a quote or the
   end of the string, so `text-smoke` or `rounded-full` never match */
const END = '($|[^\\w-])'

/* the rule: raw elements, a plain element dressed up as a button or link,
   arbitrary and stock type sizes and radii, hand-set line height and
   tracking, heavy weights, and hex colours */
const COMPONENT_LAYER_SELECTORS = [
  {
    selector: 'JSXOpeningElement[name.name=/^(button|input|select|textarea)$/]',
    message: COMPONENT_LAYER_MESSAGE,
  },
  /* role="button", and the braced role={'button'} form */
  {
    selector: "JSXOpeningElement[name.name=/^[a-z]/] > JSXAttribute[name.name='role'][value.value=/^(button|link)$/]",
    message: ROLE_MESSAGE,
  },
  {
    selector:
      "JSXOpeningElement[name.name=/^[a-z]/] > JSXAttribute[name.name='role'][value.expression.value=/^(button|link)$/]",
    message: ROLE_MESSAGE,
  },
  {
    selector:
      "JSXOpeningElement[name.name=/^[a-z]/] > JSXAttribute[name.name='role'] > JSXExpressionContainer > TemplateLiteral[expressions.length=0] > TemplateElement[value.cooked=/^(button|link)$/]",
    message: ROLE_MESSAGE,
  },
  /* `text-[#…]` is a colour, which the hex selector reports instead */
  ...classSelectors('(text|rounded(-[trblse]{1,2})?)-\\[[^#]', TYPE_SCALE_MESSAGE),
  ...classSelectors(`text-(xs|sm|base|lg|xl|\\dxl)${END}`, STOCK_TYPE_MESSAGE),
  ...classSelectors(`rounded(-[trblse]{1,2})?(-(sm|md|lg|xl|\\dxl))?${END}`, STOCK_RADIUS_MESSAGE),
  ...classSelectors('(leading|tracking)-\\[', LINE_MESSAGE),
  ...classSelectors('font-(bold|extrabold|black|\\[)', WEIGHT_MESSAGE),
  ...classSelectors('(bg|text|border)-\\[#', COLOUR_MESSAGE),
]

/* oxlint (`.oxlintrc.json`) carries the rule set, including the type-aware
   rules via tsgolint. ESLint stays for what oxlint cannot cover: the
   `no-restricted-syntax` selector below, and `no-undef` for the plain
   JavaScript that no type check sees (oxlint's is still a nursery rule).
   No type information is loaded, so this run is cheap. */
export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'desktop/src-tauri/target/', 'storybook-static/'] },
  {
    files: ['**/*.{js,mjs,cjs}'],
    rules: { 'no-undef': 'error' },
  },
  {
    /* repo maintenance scripts and the iOS dev helpers: plain ESM run directly
       by node, so they get node globals rather than the browser set */
    files: ['scripts/**/*.{js,mjs}', 'ios/scripts/**/*.{js,mjs}'],
    languageOptions: {
      globals: Object.fromEntries(
        'process console Buffer URL fetch setTimeout clearTimeout setInterval clearInterval'
          .split(' ')
          .map((g) => [g, 'readonly']),
      ),
    },
  },
  {
    /* the embeddable snippet: plain browser JS shipped as-is, no bundling —
       ES5-flavoured on purpose so it runs wherever the host app does */
    files: ['public/**/*.js'],
    languageOptions: {
      globals: Object.fromEntries(
        (
          'window document location history localStorage fetch console setTimeout clearTimeout ' +
          'matchMedia URL JSON Date Math FileReader Promise MutationObserver'
        )
          .split(' ')
          .map((g) => [g, 'readonly']),
      ),
    },
  },
  {
    /* every environment variable is declared once in server/env.ts, typed and
       validated at boot; the rest of the server reads `env.X` from there. The
       Gemini cloud worker is its own process with its own three variables. */
    files: ['server/**/*.ts'],
    ignores: ['server/env.ts', 'server/geminiCloudWorker.ts', 'server/geminiCloudWorkerMain.ts'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message: 'Read environment variables through `env` from server/env.ts, which validates them at boot.',
        },
      ],
    },
  },
  {
    /* the component layer: a screen under src/pages, src/components or
       src/integrations uses the ui primitives, not <button>/<input>/<select>/
       <textarea> or a role="button" div, sizes type and corners with the named
       steps (no text-[Npx] / rounded-[Npx], no stock text-sm / rounded-lg, no
       leading-[…] / tracking-[…]), stops at font-semibold, and colours with
       tokens, not hex. The primitives themselves (src/components/ui) are where
       raw elements and exact values belong; the editor chrome waits for its
       own pass (LEGACY_CHROME above). Stories are the catalogue, not
       screens. */
    files: ['src/pages/**/*.tsx', 'src/components/**/*.tsx', 'src/integrations/**/*.tsx'],
    ignores: ['src/components/ui/**', ...LEGACY_CHROME],
    languageOptions: { parser: tseslint.parser },
    rules: { 'no-restricted-syntax': ['error', ...COMPONENT_LAYER_SELECTORS] },
  },
)
