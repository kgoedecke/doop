import type { StorybookConfig } from '@storybook/react-vite'

/* The component catalogue: every primitive in src/components/ui plus the
   foundations (colours, type scale, radii, shadows, icons) rendered from the
   same tokens the app uses. It rides on the app's own vite.config.ts, so
   Tailwind, the `@` alias and the fonts come along without a second setup. */
const config: StorybookConfig = {
  framework: '@storybook/react-vite',
  stories: ['../src/stories/**/*.stories.tsx'],
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y'],
  core: { disableTelemetry: true },
  viteFinal: (viteConfig) => ({
    ...viteConfig,
    /* the app's dev proxy and test settings have no place in the catalogue */
    server: { ...viteConfig.server, proxy: undefined },
  }),
}

export default config
