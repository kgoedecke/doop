import type { Preview } from '@storybook/react-vite'
import { useEffect } from 'react'
import '../src/styles.css'

/* Stories render on the app's paper with the app's tokens. The toolbar's
   theme switch flips `.dark` on <html>, exactly as src/lib/theme.ts does, so
   every story can be checked in both themes without a second decorator. */
const preview: Preview = {
  globalTypes: {
    theme: {
      description: 'Light or dark tokens',
      toolbar: {
        title: 'Theme',
        icon: 'mirror',
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: 'light' },
  parameters: {
    layout: 'padded',
    backgrounds: { disable: true },
    controls: { expanded: true },
    options: {
      storySort: {
        order: ['Foundations', 'Primitives', 'Marks', 'Shell'],
      },
    },
  },
  decorators: [
    (Story, context) => {
      const dark = context.globals.theme === 'dark'
      useEffect(() => {
        document.documentElement.classList.toggle('dark', dark)
        document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
      }, [dark])
      return (
        <div className="min-h-[200px] bg-paper font-sans text-ink antialiased">
          <Story />
        </div>
      )
    },
  ],
}

export default preview
