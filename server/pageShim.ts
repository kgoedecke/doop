import type { Page } from 'puppeteer-core'

/** tsx/esbuild annotates nested functions with `__name`, and page.evaluate
 *  serialises a callback without that runtime helper. An identity shim in the
 *  page keeps evaluated code independent of the loader; install it once per
 *  page before evaluating a function that nests others. */
export async function installNameShim(page: Page): Promise<void> {
  await page.evaluate('globalThis.__name = (target) => target')
}
