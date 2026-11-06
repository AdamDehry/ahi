#!/usr/bin/env node
// Build guard: fail loud if any Syncthing conflict artifact exists in the
// repo. Syncthing writes `<name>.sync-conflict-<date>-<id>.<ext>` copies on
// conflicting edits; a `.ts` copy inside src/ gets compiled like a real
// module and breaks (or worse, silently duplicates) the build; the same
// gremlin can hit settings.json and asset folders. Wired as `prebuild` so `npm run build` can
// never compile one again. Scans the whole repo (not just src/) because the
// artifacts also corrupt config and web/ builds.

import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'logs'])

function scan(dir, hits) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) scan(join(dir, entry.name), hits)
    } else if (entry.name.includes('.sync-conflict-')) {
      hits.push(relative(ROOT, join(dir, entry.name)))
    }
  }
  return hits
}

const hits = scan(ROOT, [])

if (hits.length > 0) {
  console.error('\n🔴 BUILD BLOCKED — Syncthing conflict artifacts present:\n')
  for (const h of hits) console.error(`   ${h}`)
  console.error(
    '\nThese are Syncthing conflict copies, not source files. Diff each against\n' +
    'its original if you suspect divergent edits, then delete (or quarantine)\n' +
    'them and re-run the build. They must never be committed or compiled.\n',
  )
  process.exit(1)
}

console.log('✅ no sync-conflict artifacts')
