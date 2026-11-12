import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { build, type Plugin } from 'esbuild'
import { compile } from 'tailwindcss'
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactClient from 'react-dom/client'
import * as JSXRuntime from 'react/jsx-runtime'
import { openIsolatedPage } from './screenshot.ts'
import { fetchPinnedPublicUrl, guardPublicPageRequests } from './publicUrl.ts'
import type { RegistryItem } from './shadcnRegistry.ts'

export interface RenderedRegistryComponent {
  name: string
  description: string
  html: string
  css: string
  width: number
  height: number
  code: { path: string; name: string }
}

const RUNTIME_MODULES: Record<string, { key: string; exports: object }> = {
  react: { key: 'React', exports: React },
  'react-dom': { key: 'ReactDOM', exports: ReactDOM },
  'react-dom/client': { key: 'ReactClient', exports: ReactClient },
  'react/jsx-runtime': { key: 'JSXRuntime', exports: JSXRuntime },
  'react/jsx-dev-runtime': { key: 'JSXRuntime', exports: JSXRuntime },
}
const LOCAL_PACKAGES = /^(?:class-variance-authority|clsx|tailwind-merge|lucide-react|@radix-ui\/react-[a-z-]+)$/
const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js']
const posix = path.posix
const MODULE_ROOT = fileURLToPath(new URL('../', import.meta.url))
let runtime: Promise<string> | undefined

function browserRuntime(): Promise<string> {
  runtime ??= build({
    stdin: {
      contents:
        'export * as React from "react"; export * as ReactDOM from "react-dom"; export * as ReactClient from "react-dom/client"; export * as JSXRuntime from "react/jsx-runtime"; export {registryMount} from "./server/registryMount.ts"',
      resolveDir: MODULE_ROOT,
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: '__doopRegistryRuntime',
    platform: 'browser',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  }).then((result) => result.outputFiles[0]!.text)
  return runtime
}

function shim(module: string): string {
  const info = RUNTIME_MODULES[module]!
  return (
    `const value = globalThis.__doopRegistryRuntime.${info.key}; export default value;\n` +
    Object.keys(info.exports)
      .filter((key) => /^[a-zA-Z_$][\w$]*$/.test(key) && key !== 'default')
      .map((key) => `export const ${key} = value.${key};`)
      .join('\n')
  )
}

function sourceFiles(items: RegistryItem[]): Map<string, string> {
  const files = new Map<string, string>()
  for (const item of items)
    for (const file of item.files ?? []) {
      if (file.content === undefined) continue
      for (const name of [file.path, file.target].filter((value): value is string => !!value)) {
        const key = posix.normalize(name.replace(/^~?\//, ''))
        if (key.startsWith('../') || name.includes('\\'))
          throw new Error('Registry file paths must stay inside the registry')
        if (files.has(key) && files.get(key) !== file.content) throw new Error(`Conflicting registry files: ${key}`)
        files.set(key, file.content)
      }
    }
  return files
}

function resolveFile(files: Map<string, string>, request: string, importer = ''): string | undefined {
  const relative = request.startsWith('.')
  const wanted = relative
    ? posix.normalize(posix.join(posix.dirname(importer), request))
    : request.replace(/^(?:@\/|~\/)/, '')
  const candidates = [wanted, ...EXTENSIONS.map((extension) => wanted + extension)]
  for (const name of candidates) if (files.has(name)) return name
  if (relative) return undefined
  const matches = [...files.keys()].filter((name) => candidates.some((candidate) => name.endsWith('/' + candidate)))
  if (matches.length === 1) return matches[0]
  // shadcn's aliases commonly add components/ before a registry's ui/ folder.
  const tail = wanted.split('/').slice(-2).join('/')
  const suffixes = [tail, ...EXTENSIONS.map((extension) => tail + extension)]
  const aliases = [...files.keys()].filter((name) =>
    suffixes.some((suffix) => name === suffix || name.endsWith('/' + suffix)),
  )
  return aliases.length === 1 ? aliases[0] : undefined
}

function entryFile(item: RegistryItem): string {
  const files = (item.files ?? []).filter((file) => /\.[jt]sx?$/.test(file.path))
  const entry =
    files.find((file) => file.type === 'registry:page') ??
    files.find((file) => posix.basename(file.path).replace(/\.[^.]+$/, '') === item.name) ??
    files.find((file) => /\.[jt]sx$/.test(file.path)) ??
    files[0]
  if (!entry) throw new Error(`“${item.name}” has no renderable React source`)
  return posix.normalize(entry.path.replace(/^~?\//, ''))
}

export async function bundleRegistryComponent(item: RegistryItem, items: RegistryItem[]) {
  const files = sourceFiles(items)
  const entry = entryFile(item)
  const pascal = (text: string) => text.replace(/(?:^|[-_.])(\w)/g, (_match, char: string) => char.toUpperCase())
  const preferred = [pascal(posix.basename(entry).replace(/\.[^.]+$/, '')), pascal(item.name)]
  const plugin: Plugin = {
    name: 'registry-source',
    setup(builder) {
      builder.onResolve({ filter: /^doop:entry$/ }, () => ({ path: entry, namespace: 'registry' }))
      builder.onResolve({ filter: /.*/, namespace: 'registry' }, async (args) => {
        if (args.path in RUNTIME_MODULES) return { path: args.path, namespace: 'runtime' }
        const local = resolveFile(files, args.path, args.importer)
        if (local) return { path: local, namespace: 'registry' }
        if (/^(?:cn|@\/lib\/utils|~\/lib\/utils)$/.test(args.path)) return { path: 'utils', namespace: 'utils' }
        if (args.path.startsWith('.') || args.path.startsWith('@/') || args.path.startsWith('~/')) {
          throw new Error(`Missing registry source: ${args.path}`)
        }
        if (!/^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-zA-Z0-9._/-]+)?$/.test(args.path)) {
          throw new Error(`Unsupported registry import: ${args.path}`)
        }
        if (LOCAL_PACKAGES.test(args.path)) {
          const result = await builder.resolve(args.path, { kind: 'import-statement', resolveDir: MODULE_ROOT })
          if (!result.errors.length) return result
        }
        return { path: `https://esm.sh/${args.path}?bundle&external=react,react-dom`, external: true }
      })
      // Installed browser packages share the same React as remotely bundled packages.
      builder.onResolve({ filter: /^(react(?:\/.*)?|react-dom(?:\/.*)?)$/ }, (args) =>
        args.path in RUNTIME_MODULES ? { path: args.path, namespace: 'runtime' } : undefined,
      )
      builder.onResolve({ filter: /^(clsx|tailwind-merge)$/, namespace: 'utils' }, (args) =>
        builder.resolve(args.path, { kind: 'import-statement', resolveDir: MODULE_ROOT }),
      )
      builder.onLoad({ filter: /.*/, namespace: 'utils' }, () => ({
        contents:
          'import {clsx} from "clsx"; import {twMerge} from "tailwind-merge"; export function cn(...values){return twMerge(clsx(values))}',
        loader: 'js',
      }))
      builder.onLoad({ filter: /.*/, namespace: 'runtime' }, (args) => ({ contents: shim(args.path), loader: 'js' }))
      builder.onLoad({ filter: /.*/, namespace: 'registry' }, (args) => ({
        contents: args.path.endsWith('.css') ? '' : files.get(args.path)!,
        loader: /\.[jt]sx$/.test(args.path) ? 'tsx' : 'ts',
      }))
    },
  }
  const result = await build({
    stdin: {
      contents: `import * as entry from "doop:entry";
const preferred = ${JSON.stringify(preferred)};
const runtime = globalThis.__doopRegistryRuntime;
const mounted = runtime.registryMount(entry, preferred, ${JSON.stringify(item.title ?? pascal(item.name))});
const root = runtime.ReactClient.createRoot(document.getElementById('registry-root'));
window.__registryExport = mounted.name;
root.render(mounted.node);`,
      sourcefile: '__entry.tsx',
      loader: 'tsx',
    },
    plugins: [plugin],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  })
  return { javascript: result.outputFiles[0]!.text, entry }
}

const DEFAULT_THEME = `:root{--background:oklch(1 0 0);--foreground:oklch(.145 0 0);--card:var(--background);--card-foreground:var(--foreground);--popover:var(--background);--popover-foreground:var(--foreground);--primary:oklch(.205 0 0);--primary-foreground:oklch(.985 0 0);--secondary:oklch(.97 0 0);--secondary-foreground:var(--primary);--muted:oklch(.97 0 0);--muted-foreground:oklch(.556 0 0);--accent:var(--muted);--accent-foreground:var(--foreground);--destructive:oklch(.577 .245 27.325);--border:oklch(.922 0 0);--input:var(--border);--ring:oklch(.708 0 0);--radius:.625rem}`
const COLORS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'border',
  'input',
  'ring',
  ...Array.from({ length: 5 }, (_, i) => `chart-${i + 1}`),
]

function registryCss(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  return Object.entries(value)
    .map(([key, entry]) => {
      if (key.startsWith('@apply ')) return `${key};`
      if (entry && typeof entry === 'object') return `${key}{${registryCss(entry)}}`
      if (typeof entry !== 'string' && typeof entry !== 'number') return ''
      return key === '@apply' ? `@apply ${entry};` : `${key}:${entry};`
    })
    .join('')
}

async function componentCss(items: RegistryItem[], candidates: string[]): Promise<string> {
  const theme = await readFile(new URL(import.meta.resolve('tailwindcss/theme.css')), 'utf8')
  const preflight = await readFile(new URL(import.meta.resolve('tailwindcss/preflight.css')), 'utf8')
  const aliases = `@theme inline{${COLORS.map((name) => `--color-${name}:var(--${name});`).join('')}--radius-sm:calc(var(--radius) - 4px);--radius-md:calc(var(--radius) - 2px);--radius-lg:var(--radius);--radius-xl:calc(var(--radius) + 4px);}`
  const variables = items
    .flatMap((item) => {
      const cssVars = item.cssVars as Record<string, Record<string, unknown>> | undefined
      return ['theme', 'light'].flatMap((mode) =>
        Object.entries(cssVars?.[mode] ?? {})
          .filter(([key, value]) => /^[\w-]+$/.test(key) && typeof value === 'string')
          .map(([key, value]) => `--${key}:${String(value)};`),
      )
    })
    .join('')
  const extra = items
    .flatMap((item) => [
      registryCss(item.css),
      ...(item.files ?? []).filter((file) => file.path.endsWith('.css')).map((file) => file.content ?? ''),
    ])
    .join('\n')
    .replace(/@import\s+['"](?:tailwindcss|tw-animate-css)['"]\s*;?/g, '')
  const compiler = await compile(`${theme}\n${aliases}\n@tailwind utilities;\n${extra}`)
  return `${preflight}\n${DEFAULT_THEME}\n:root{${variables}}\n${compiler.build(candidates)}`
}

/** React runs only in a disposable browser, with no app cookies, server APIs,
 * filesystem, package installs or Node execution. Only passive HTML/CSS leave it. */
export async function renderRegistryComponent(
  item: RegistryItem,
  items: RegistryItem[],
): Promise<RenderedRegistryComponent> {
  const bundled = await bundleRegistryComponent(item, items)
  const isolated = await openIsolatedPage()
  const { page } = isolated
  const deadline = setTimeout(() => {
    void isolated.close()
  }, 30_000)
  try {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(String(error)))
    await guardPublicPageRequests(page, {
      fetchUrl: (raw, init) => {
        if (new URL(raw).origin !== 'https://esm.sh')
          throw new Error('Registry rendering only loads browser package modules')
        return fetchPinnedPublicUrl(raw, init)
      },
    })
    await page.setViewport({ width: 1024, height: 768 })
    const imports = Object.fromEntries(
      Object.keys(RUNTIME_MODULES).map((name) => [
        name,
        'data:text/javascript;base64,' + Buffer.from(shim(name)).toString('base64'),
      ]),
    )
    const policy =
      "default-src 'none'; script-src 'unsafe-inline' data: blob: https://esm.sh; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    await page.setContent(
      `<html><head><meta http-equiv="Content-Security-Policy" content="${policy}"></head><body><div id="registry-root"></div></body></html>`,
    )
    await page.addScriptTag({ content: await browserRuntime() })
    await page.addScriptTag({ type: 'importmap', content: JSON.stringify({ imports }) })
    await page.addScriptTag({ type: 'module', content: bundled.javascript })
    try {
      await page.waitForFunction(() => !!document.getElementById('registry-root')?.children.length, { timeout: 20_000 })
    } catch {
      throw new Error(
        `Could not render “${item.name}”. ${errors[0] ?? 'The component may require application props or providers; import a self-contained example.'}`,
      )
    }
    const candidates = await page.evaluate(() => [
      ...new Set([...document.querySelectorAll('*')].flatMap((element) => [...element.classList])),
    ])
    const css = await componentCss(items, candidates)
    await page.addStyleTag({ content: css })
    const snapshot = await page.evaluate(() => {
      const root = document.createElement('div')
      for (const element of document.body.children) {
        if (element.id === 'registry-root')
          root.append(...[...element.childNodes].map((child) => child.cloneNode(true)))
        else if (!['SCRIPT', 'STYLE', 'LINK'].includes(element.tagName)) root.append(element.cloneNode(true))
      }
      const boxes = [...document.body.children]
        .flatMap((element) =>
          element.id === 'registry-root'
            ? [...element.children]
            : ['SCRIPT', 'STYLE', 'LINK'].includes(element.tagName)
              ? []
              : [element],
        )
        .map((element) => element.getBoundingClientRect())
      const bounds = {
        width: Math.max(0, ...boxes.map((box) => box.right)) - Math.min(0, ...boxes.map((box) => box.left)),
        height: Math.max(0, ...boxes.map((box) => box.bottom)) - Math.min(0, ...boxes.map((box) => box.top)),
      }
      const styles = [...document.styleSheets]
        .flatMap((sheet) => {
          try {
            return [...sheet.cssRules].map((rule) => rule.cssText)
          } catch {
            return []
          }
        })
        .join('\n')
      const clone = root.cloneNode(true) as HTMLElement
      for (const element of clone.querySelectorAll('script,style,link,meta,base,iframe,object,embed')) element.remove()
      for (const element of [clone, ...clone.querySelectorAll('*')])
        for (const attr of [...element.attributes]) {
          // URL schemes can hide executable prefixes behind control characters.
          const value = [...attr.value].filter((char) => char.charCodeAt(0) > 32).join('')
          if (
            /^on/i.test(attr.name) ||
            ['srcdoc', 'ping', 'action', 'formaction'].includes(attr.name) ||
            /^(?:javascript:|vbscript:|data:text\/html[;,])/i.test(value)
          )
            element.removeAttribute(attr.name)
        }
      return {
        html: clone.innerHTML,
        css: styles,
        width: Math.ceil(bounds.width),
        height: Math.ceil(bounds.height),
        exportName: (window as unknown as { __registryExport: string }).__registryExport,
      }
    })
    if (!snapshot.html.trim() || snapshot.html.length + snapshot.css.length > 2_500_000)
      throw new Error('Rendered registry component is empty or too large')
    return {
      name: item.title ?? item.name,
      description: item.description ?? '',
      html: snapshot.html,
      css: snapshot.css.replace(/<\/style/gi, '<\\/style'),
      width: Math.min(1440, Math.max(160, snapshot.width + 48)),
      height: Math.min(4000, Math.max(100, snapshot.height + 48)),
      code: { path: bundled.entry, name: snapshot.exportName },
    }
  } finally {
    clearTimeout(deadline)
    await isolated.close()
  }
}
