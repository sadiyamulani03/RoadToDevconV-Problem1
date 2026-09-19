// Syntax-only build gate: every src/script file must parse under node --check.
// No bundling, no codegen — keeps the foundation auditable.
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function collectJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      collectJsFiles(full, out)
    } else if (full.endsWith('.js')) {
      out.push(full)
    }
  }
  return out
}

const files = [...collectJsFiles('src'), ...collectJsFiles('scripts'), ...collectJsFiles('tests')]

if (files.length === 0) {
  console.error('build: no source files found')
  process.exit(1)
}

for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' })
}

console.log(`build: OK (${files.length} files syntax-checked)`)
