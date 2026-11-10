// Merges the Apple Silicon and Intel builds of the Chromium shell into one
// universal doop.app, the way Electron apps are made universal: the Tauri 3
// CLI bundles CEF for one architecture at a time, so macos-universal.sh builds
// both and this lipo's every Mach-O file together (@electron/universal),
// requiring every other file to match.
//
//   bun scripts/universal-app.mjs <arm64 doop.app> <x64 doop.app> <out doop.app>
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { makeUniversalApp } from '@electron/universal'

const args = process.argv.slice(2)
if (args.length !== 3) {
  console.error('usage: universal-app.mjs <arm64 app> <x64 app> <out app>')
  process.exit(2)
}
// @electron/universal takes absolute paths only
const [arm64AppPath, x64AppPath, outAppPath] = args.map((app) => path.resolve(app))

/* its last step compares an Electron app's JavaScript in Contents/Resources/app;
   a Tauri app has none, so an empty one on each side makes that a no-op */
const electronAppDir = (app) => path.join(app, 'Contents', 'Resources', 'app')
await Promise.all([arm64AppPath, x64AppPath].map((app) => mkdir(electronAppDir(app), { recursive: true })))

await makeUniversalApp({
  arm64AppPath,
  x64AppPath,
  outAppPath,
  force: true,
})
await Promise.all(
  [arm64AppPath, x64AppPath, outAppPath].map((app) => rm(electronAppDir(app), { recursive: true, force: true })),
)
console.log(`universal app at ${outAppPath}`)
