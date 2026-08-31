#!/usr/bin/env node
// scripts/doc-lint.mjs
//
// Enforces the CLAUDE.md + .context/ convention in CI so the project's context
// docs cannot silently rot. Zero dependencies; Node 18+.
//
// Installed by the `context-pattern` skill. ADAPT THE CONFIG BLOCK BELOW to the
// repo -- at minimum SOURCE_DIRS and REQUIRED_CONTEXT_DOCS. Everything under
// "Rules" is generic and should not need editing.
//
// Errors fail the build (exit 1). Warnings are printed and pass.
//
// Escape hatches, for when the guard is in the way but you do not want to
// unwire it:
//   DOCLINT_SKIP=1                 exit 0 immediately, check nothing
//   --warn-only | DOCLINT_WARN_ONLY=1
//                                  run every rule, print errors, still exit 0
// Prefer --warn-only while a repo is being brought up to the convention: it
// keeps the findings visible. DOCLINT_SKIP hides them, so treat it as
// temporary. To remove the guard for good, unwire it (drop the npm script, CI
// step, or hook) and delete this file.
//
// Design note on index symmetry -- the invariant is narrow, not absolute. In
// EVERY index, an entry pointing at a missing file is an ERROR. The reverse
// direction depends on what reading the index costs:
//
//   .context/INDEX.md      @-imported by CLAUDE.md, so it loads on every agent
//   (Rule 4, WARNING)      session. A repo with years of accumulated specs/ and
//                          plans/ is right to let finished work age out of it.
//                          Erroring here fails healthy repos and "fixes" them
//                          by bloating the one file the convention exists to
//                          keep small.
//   .context/<dir>/INDEX.md  reached only by a link, so it costs nothing until
//   (Rule 9, ERROR)          something reads it. Completeness is free, and
//                            therefore enforceable: these files are the full
//                            record of their folder.
//
// The repo that motivated the original one-way rule -- 161 files under
// .context/ behind a 72-line INDEX.md, where a symmetric root rule produced 122
// false findings -- becomes conformant under this split by gaining a complete
// specs/INDEX.md, not by growing its root index. Rule 4 therefore skips
// anything inside a CHILD_INDEX_DIRS folder: Rule 9 owns those entries, and
// double-reporting them would re-create the noise.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname, relative, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const ROOT = resolve(dirname(__filename), '..')
const CONTEXT_DIR = join(ROOT, '.context')

// Checked before any rule runs, so a skipped run costs nothing.
if (process.env.DOCLINT_SKIP) {
  console.log('doc-lint skipped (DOCLINT_SKIP is set)')
  process.exit(0)
}

// Downgrades errors to a non-fatal report. Every rule still runs and every
// finding is still printed -- only the exit code changes.
const WARN_ONLY = process.argv.includes('--warn-only') || !!process.env.DOCLINT_WARN_ONLY

// ============================ CONFIG - ADAPT ME ============================

// Root-level files that must exist.
const REQUIRED_ROOT_FILES = ['CLAUDE.md', 'README.md']

// Standing docs under .context/ that must exist. Add CODESTYLE.md, DESIGN.md,
// RELEASE.md, ARCHITECTURE.md etc. only if this repo actually has them -- the
// convention says never require a doc the repo cannot fill with real content.
const REQUIRED_CONTEXT_DOCS = ['INDEX.md', 'TECHSTACK.md', 'DESIGN.md', 'CODESTYLE.md', 'RELEASE.md']

// Subfolders of .context/ that own their own complete INDEX.md. These grow one
// file per unit of work forever, so their index is a link (never @-imported)
// and completeness in it is free -- which is why symmetry is an ERROR here but
// only a warning for the root index. Folders NOT listed here (e.g. reference/)
// keep their entries inline in the root index.
const CHILD_INDEX_DIRS = ['specs', 'plans']

// Directories holding source the docs describe, for the freshness check.
// Non-existent entries are skipped, so listing extras is harmless.
const SOURCE_DIRS = ['src', 'server', 'shared', 'desktop', 'tests']

// File extensions counted as source for the freshness check.
const SOURCE_EXT_RE = /\.(go|java|kt|rs|py|ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/

// Path fragments excluded from the freshness check (generated or vendored).
const GENERATED_MARKERS = [
  'node_modules',
  'dist',
  'build',
  'target',
  'vendor',
  '.generated',
  'wailsjs',
  'src-tauri/gen',
]

// Max lines for CLAUDE.md before warning. The convention's guidance is 200.
const CLAUDE_MD_MAX_LINES = 200

// Strings that mark a doc as still-unfilled scaffolding.
const PLACEHOLDER_MARKERS = ['_(populate)_', '<!-- SCAFFOLD:', '[Placeholder]']

// ========================== END CONFIG - ADAPT ME ==========================

const errors = []
const warnings = []

const err = (msg) => errors.push(msg)
const warn = (msg) => warnings.push(msg)

function readIfExists(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// Every markdown link target in `src`, normalized: fragments stripped, external
// URLs dropped, blanks dropped. Paths stay relative to the linking file.
function markdownLinkTargets(src) {
  const targets = new Set()
  const linkRe = /]\(([^)]+)\)/g
  let match
  while ((match = linkRe.exec(src))) {
    const target = match[1].trim().split('#')[0]
    if (!target) continue
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) continue // external URL
    targets.add(target)
  }
  return targets
}

// Recursively collect files under `dir`, optionally filtered by `filterFn`.
function walk(dir, filterFn) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walk(p, filterFn))
    } else if (!filterFn || filterFn(p, entry)) {
      out.push(p)
    }
  }
  return out
}

// ---------------- Rule 1: CLAUDE.md exists and wires in INDEX.md ----------------

const claudeMdPath = join(ROOT, 'CLAUDE.md')
const claudeMd = readIfExists(claudeMdPath)

if (claudeMd === null) {
  err('CLAUDE.md is missing')
} else {
  if (!/^@\.context\/INDEX\.md\s*$/m.test(claudeMd)) {
    err(
      'CLAUDE.md must @-import .context/INDEX.md (add "@.context/INDEX.md" as its own line, near the top)',
    )
  }

  const lineCount = claudeMd.split('\n').length
  if (lineCount > CLAUDE_MD_MAX_LINES) {
    warn(
      `CLAUDE.md is ${lineCount} lines (guidance: under ${CLAUDE_MD_MAX_LINES}); move detail into .context/ and link it from INDEX.md`,
    )
  }

  // Over-importing: specs/plans/reference should be INDEX links, not @-imports,
  // because every @-import is paid for on every session.
  const overImports = [...claudeMd.matchAll(/^@(\.context\/(?:specs|plans|reference)\/\S+)/gm)]
  for (const m of overImports) {
    warn(
      `CLAUDE.md @-imports "${m[1]}"; specs/plans/reference belong in INDEX.md as links, not as always-loaded imports`,
    )
  }
}

// ---------------- Rule 2: required files exist ----------------

for (const f of REQUIRED_ROOT_FILES) {
  if (!existsSync(join(ROOT, f))) {
    err(`Missing required root file: ${f}`)
  }
}

for (const f of REQUIRED_CONTEXT_DOCS) {
  if (!existsSync(join(CONTEXT_DIR, f))) {
    err(`Missing required context doc: .context/${f}`)
  }
}

// ---------------- Rules 3 & 4: INDEX.md <-> .context/ consistency ----------------

const indexPath = join(CONTEXT_DIR, 'INDEX.md')
const indexSrc = readIfExists(indexPath)
const rootLinkedPaths = new Set()

if (indexSrc === null) {
  // Already reported by Rule 2 if it was in REQUIRED_CONTEXT_DOCS.
  if (!REQUIRED_CONTEXT_DOCS.includes('INDEX.md')) {
    err('.context/INDEX.md is missing')
  }
} else {
  for (const target of markdownLinkTargets(indexSrc)) rootLinkedPaths.add(target)

  // Rule 3 (ERROR): every INDEX entry must resolve. A stale entry is always a
  // defect -- it points an agent at a file that is not there.
  for (const link of rootLinkedPaths) {
    if (!existsSync(join(CONTEXT_DIR, link))) {
      err(`.context/INDEX.md links to "${link}", which does not exist`)
    }
  }

  // Rule 4 (WARNING): unlisted docs. See the design note at the top of this
  // file for why this is deliberately not an error.
  const docsOnDisk = walk(CONTEXT_DIR, (p) => extname(p) === '.md').filter(
    (p) => resolve(p) !== resolve(indexPath),
  )
  const unlisted = docsOnDisk
    .map((doc) => relative(CONTEXT_DIR, doc).split('\\').join('/'))
    .filter((rel) => !rootLinkedPaths.has(rel))

  // A missing STANDING doc is a stronger signal than an old spec aging out, so
  // call those out individually and summarize the rest.
  //
  // A DIRECT child of a child-index folder is Rule 9's business, not this
  // warning's. Anything nested DEEPER than that is nobody's otherwise -- Rule 9
  // only reads the folder's top level -- so it stays here rather than falling
  // through both rules unchecked. It is also off-convention: specs/ and plans/
  // are flat, and only reference/ nests by topic.
  const isDirectChildOf = (rel, dir) => {
    const prefix = `${dir}/`
    return rel.startsWith(prefix) && !rel.slice(prefix.length).includes('/')
  }
  const isDirectChildOfChildIndexDir = (rel) =>
    CHILD_INDEX_DIRS.some((dir) => isDirectChildOf(rel, dir))

  const standingUnlisted = unlisted.filter((rel) => !rel.includes('/'))
  const nestedUnlisted = unlisted.filter(
    (rel) => rel.includes('/') && !isDirectChildOfChildIndexDir(rel),
  )

  for (const rel of standingUnlisted) {
    warn(`.context/${rel} is a standing doc but is not linked from .context/INDEX.md`)
  }
  if (nestedUnlisted.length > 0) {
    warn(
      `${nestedUnlisted.length} file(s) under .context/ are not linked from INDEX.md (expected as finished work ages out; add an entry only if still current)`,
    )
  }
}

// ---------------- Rule 5: no placeholder-only standing docs ----------------

for (const f of REQUIRED_CONTEXT_DOCS) {
  const content = readIfExists(join(CONTEXT_DIR, f))
  if (content === null) continue
  const hit = PLACEHOLDER_MARKERS.find((marker) => content.includes(marker))
  if (hit) {
    warn(`.context/${f} still contains the placeholder marker "${hit}"; fill it in or delete it`)
  }
}

// ---------------- Rule 6: freshness (warning only) ----------------
// If source has changed more recently than every doc describing it, nudge.
// Mtimes are meaningless right after a fresh checkout (everything lands at
// once), so this only bites in a real working tree -- which is when it helps.

const sourceFiles = SOURCE_DIRS.flatMap((d) =>
  walk(join(ROOT, d), (p) => {
    if (!SOURCE_EXT_RE.test(p)) return false
    return !GENERATED_MARKERS.some((marker) => p.includes(marker))
  }),
)

const docFiles = [claudeMdPath, ...walk(CONTEXT_DIR, (p) => extname(p) === '.md')].filter(existsSync)

if (sourceFiles.length > 0 && docFiles.length > 0) {
  const newestDocMtime = Math.max(...docFiles.map((p) => statSync(p).mtimeMs))

  let newestSourceMtime = 0
  let newestSourcePath = null
  for (const s of sourceFiles) {
    const mtime = statSync(s).mtimeMs
    if (mtime > newestSourceMtime) {
      newestSourceMtime = mtime
      newestSourcePath = s
    }
  }

  if (newestSourcePath && newestSourceMtime > newestDocMtime) {
    warn(
      `Stale docs: ${relative(ROOT, newestSourcePath)} is newer than every file in CLAUDE.md / .context/ - consider updating the docs`,
    )
  }
}

// ------- Rules 7-12: hierarchical child indexes (.context/<dir>/INDEX.md) -------
// Each folder in CHILD_INDEX_DIRS is the complete record of itself. Its index is
// reached by a link rather than @-imported, so nothing is paid for until
// something reads it. That is what makes it fair to demand completeness here --
// and to demand that an entry marked archived really is gone from the tree.

const HEADING_RE = /^(#{1,6})\s+/
const ARCHIVED_HEADING_RE = /^(#{1,6})\s+Archived\b/i

// Where the "Archived" heading is and how deep, or null if there is none.
function findArchivedHeading(lines) {
  for (const [index, line] of lines.entries()) {
    const heading = ARCHIVED_HEADING_RE.exec(line)
    if (heading) return { index, level: heading[1].length }
  }
  return null
}

// The lines under the first "Archived" heading, running to the next heading of
// the same or a higher level, or to EOF.
function archivedSectionLines(src) {
  const lines = src.split('\n')
  const heading = findArchivedHeading(lines)
  if (heading === null) return []

  const body = []
  for (const line of lines.slice(heading.index + 1)) {
    const nextHeading = HEADING_RE.exec(line)
    if (nextHeading && nextHeading[1].length <= heading.level) break
    body.push(line)
  }
  return body
}

// Group lines into top-level "- " list items, folding wrapped continuation
// lines into the item they belong to. Indented sub-bullets fold in too, since
// only the top-level item counts as one entry.
function topLevelListItems(lines) {
  const items = []
  let current = null
  for (const line of lines) {
    if (/^[-*]\s+/.test(line)) {
      if (current !== null) items.push(current)
      current = line
    } else if (current !== null) {
      if (line.trim() === '') {
        items.push(current)
        current = null
      } else {
        current += `\n${line}`
      }
    }
  }
  if (current !== null) items.push(current)
  return items
}

// An archived entry names its file in backticks, never as a link: a link to a
// removed file would be a stale entry, which Rule 8 rejects outright.
const BACKTICKED_MD_RE = /`([^`]+\.md)`/g

// A recovery SHA, in either form the convention accepts. Backticked is what the
// template writes and is taken as-is. A bare token must contain a digit, because
// an all-[a-f] run is far more likely to be an English word ("defaced") than a
// commit: the cost of that guess is a spurious "add a SHA" nudge on the rare
// digitless bare SHA, versus silently vouching for recoverability that does not
// exist.
const BACKTICKED_SHA_RE = /`[0-9a-fA-F]{7,40}`/
const BARE_SHA_RE = /\b(?=[0-9a-fA-F]{7,40}\b)[a-fA-F]*[0-9][0-9a-fA-F]*\b/

function hasRecoverySha(entry) {
  if (BACKTICKED_SHA_RE.test(entry)) return true
  return BARE_SHA_RE.test(entry.replace(BACKTICKED_MD_RE, ' '))
}

for (const dir of CHILD_INDEX_DIRS) {
  const childDir = join(CONTEXT_DIR, dir)
  if (!existsSync(childDir)) continue // a folder that does not exist owes nothing

  const childIndexPath = join(childDir, 'INDEX.md')
  const childIndexSrc = readIfExists(childIndexPath)

  // Rule 7 (ERROR): the folder must have an index at all.
  if (childIndexSrc === null) {
    err(`.context/${dir}/ exists but has no INDEX.md`)
    continue
  }

  const childLinks = markdownLinkTargets(childIndexSrc)

  // Rule 8 (ERROR): every entry resolves, relative to the child folder. Links
  // may escape it (../INDEX.md) and must still land on a real file.
  for (const link of childLinks) {
    if (!existsSync(join(childDir, link))) {
      err(`.context/${dir}/INDEX.md links to "${link}", which does not exist`)
    }
  }

  // Rule 9 (ERROR): the symmetry flip -- every .md in the folder is listed.
  // Non-markdown siblings (fixtures, feature files) are not index material.
  const childDocs = readdirSync(childDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name) === '.md' && entry.name !== 'INDEX.md')
    .map((entry) => entry.name)

  for (const name of childDocs) {
    if (!childLinks.has(name) && !childLinks.has(`./${name}`)) {
      err(`.context/${dir}/${name} is not listed in .context/${dir}/INDEX.md`)
    }
  }

  for (const item of topLevelListItems(archivedSectionLines(childIndexSrc))) {
    const archivedNames = [...item.matchAll(BACKTICKED_MD_RE)].map((m) => m[1])
    if (archivedNames.length === 0) continue // prose or a non-file entry

    // Rule 10 (ERROR): "archived" means summarized AND removed. A file that is
    // still on disk is either not archived or was listed by mistake, and either
    // way the index is now lying about the working tree.
    for (const name of archivedNames) {
      // Resolve against every base the convention plausibly means, because a
      // form that silently matches nothing would turn this error into a
      // guarantee it is not making. Bare name -> this folder; a path -> either
      // repo-root-relative (.context/specs/x.md) or .context-relative
      // (specs/x.md), both of which people write.
      const bases = name.includes('/') ? [ROOT, CONTEXT_DIR] : [childDir]
      if (bases.some((base) => existsSync(join(base, name)))) {
        err(`.context/${dir}/INDEX.md lists "${name}" as archived, but the file still exists`)
      }
    }

    // Rule 11 (WARNING): the SHA is the only handle left on the removed file, so
    // an entry without one is a summary of something nobody can get back.
    if (!hasRecoverySha(item)) {
      warn(
        `.context/${dir}/INDEX.md archived entry "${archivedNames[0]}" has no recovery SHA; recoverability cannot be verified`,
      )
    }
  }

  // Rule 12 (ERROR): a child index is not @-imported, so a root-index link is
  // the only thing that makes it reachable.
  if (
    indexSrc !== null &&
    !rootLinkedPaths.has(`${dir}/INDEX.md`) &&
    !rootLinkedPaths.has(`./${dir}/INDEX.md`)
  ) {
    err(
      `.context/INDEX.md does not link to .context/${dir}/INDEX.md, so the ${dir} index is unreachable`,
    )
  }
}

// ---------------- Report ----------------

if (warnings.length > 0) {
  console.log('doc-lint warnings:')
  for (const w of warnings) console.log(`  ! ${w}`)
  console.log('')
}

if (errors.length > 0) {
  console.log('doc-lint errors:')
  for (const e of errors) console.log(`  x ${e}`)
  if (WARN_ONLY) {
    console.log(`\ndoc-lint: ${errors.length} error(s), not failing (--warn-only)`)
    process.exit(0)
  }
  console.log(`\ndoc-lint failed: ${errors.length} error(s)`)
  process.exit(1)
}

console.log(`doc-lint passed (${warnings.length} warning(s))`)
