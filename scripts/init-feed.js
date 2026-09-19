#!/usr/bin/env node
// One-time feed identity setup for LOCAL DEVELOPMENT ONLY.
// - Topic is deterministic: 'tsering-archive-v1' (documented, reproducible).
// - Owner is derived from a fresh random dev keypair via the real SDK.
// - The private key is written ONLY to untracked .env (FEED_PRIVATE_KEY).
// - The public owner + topic are written to tracked feed.json (no secrets).
// Safe to re-run: reuses the existing FEED_PRIVATE_KEY when present.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrivateKey } from '@ethersphere/bee-js'

export const DEV_FEED_TOPIC = 'tsering-archive-v1'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const envPath = join(rootDir, '.env')
const feedJsonPath = join(rootDir, 'feed.json')

function readEnvMap() {
  if (!existsSync(envPath)) return new Map()
  const map = new Map()
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (match) map.set(match[1], match[2].trim())
  }
  return map
}

const env = readEnvMap()
let privateKeyHex = env.get('FEED_PRIVATE_KEY') ?? ''

if (!privateKeyHex) {
  privateKeyHex = `0x${Buffer.from(randomBytes(32)).toString('hex')}`
  appendFileSync(envPath, `${existsSync(envPath) && readFileSync(envPath, 'utf8').length > 0 ? '\n' : ''}FEED_PRIVATE_KEY=${privateKeyHex}\n`)
  console.log('Generated dev FEED_PRIVATE_KEY and appended it to untracked .env (never commit).')
} else {
  console.log('Reusing existing FEED_PRIVATE_KEY from .env.')
}

const owner = new PrivateKey(privateKeyHex).publicKey().address().toHex()

const identity = {
  version: 1,
  topic: DEV_FEED_TOPIC,
  owner,
  notes:
    'Local-development feed identity. Public owner+topic are tracked here; ' +
    'the private key lives ONLY in untracked .env as FEED_PRIVATE_KEY. ' +
    'A production deployment MUST generate a fresh keypair and update owner.',
}

writeFileSync(feedJsonPath, `${JSON.stringify(identity, null, 2)}\n`)
console.log(`Wrote tracked feed.json: topic=${identity.topic} owner=${owner}`)
