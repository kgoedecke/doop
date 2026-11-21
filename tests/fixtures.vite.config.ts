import { readdirSync } from 'node:fs'
import { mergeConfig, type UserConfig } from 'vite'
import app from '../vite.config.ts'

/* The production build the browser tests load (tests/browser.ts runs it once
   per test run): the app's own build with every fixture page as an entry
   beside index.html, minified as it ships. No .env file is read, so the pages
   are the same on every machine, and no source maps are written: nothing
   reads them, and the build stays about a second. */
const pages: UserConfig = {
  logLevel: 'error',
  envDir: false,
  build: {
    emptyOutDir: true,
    sourcemap: false,
    reportCompressedSize: false,
    rollupOptions: {
      input: [
        'index.html',
        ...readdirSync('tests/fixtures')
          .filter((name) => name.endsWith('.html'))
          .map((name) => `tests/fixtures/${name}`),
      ],
    },
  },
}

export default mergeConfig(app as UserConfig, pages)
