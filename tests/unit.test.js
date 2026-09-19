// Offline unit tests — no Bee node, no network, no fabricated chain data.
// Run with: npm test (node --test tests/)
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  loadConfig,
  isValidHttpUrl,
  isValidHex64,
  DEFAULT_BEE_API_URL,
} from '../src/config.js'
import { buildArchivePayload, parseArchivePayload } from '../src/archive.js'
import { selectUsableBatch, formatBatchSummary, findBatchById } from '../src/postage.js'
import { formatRecoverySummary } from '../src/recovery.js'
import { formatStatusSummary } from '../src/status.js'
import { resolveNextIndex, zeroIndex } from '../src/feed.js'

describe('config', () => {
  it('defaults to localhost Bee URL', () => {
    const config = loadConfig({})
    assert.equal(config.beeApiUrl, DEFAULT_BEE_API_URL)
  })

  it('rejects invalid Bee URLs', () => {
    assert.throws(() => loadConfig({ BEE_API_URL: 'not-a-url' }), /Invalid BEE_API_URL/)
  })

  it('validates http urls', () => {
    assert.equal(isValidHttpUrl('http://localhost:1633'), true)
    assert.equal(isValidHttpUrl('https://bee.example.com'), true)
    assert.equal(isValidHttpUrl('ftp://x'), false)
    assert.equal(isValidHttpUrl(''), false)
  })

  it('validates 64-char hex batch ids', () => {
    assert.equal(isValidHex64('a'.repeat(64)), true)
    assert.equal(isValidHex64('xyz'), false)
  })
})

describe('archive payload', () => {
  it('builds and parses a round-trip payload', () => {
    const raw = buildArchivePayload({ title: 'Tsering', body: 'Testimony', createdAt: '2026-01-01T00:00:00.000Z' })
    const parsed = parseArchivePayload(raw)
    assert.equal(parsed.title, 'Tsering')
    assert.equal(parsed.body, 'Testimony')
    assert.equal(parsed.version, 1)
  })

  it('rejects empty title/body', () => {
    assert.throws(() => buildArchivePayload({ title: '', body: 'x' }), /title/)
    assert.throws(() => buildArchivePayload({ title: 'x', body: '' }), /body/)
  })

  it('rejects invalid JSON and versions', () => {
    assert.throws(() => parseArchivePayload('nope'), /valid JSON/)
    assert.throws(() => parseArchivePayload('{"version":99}'), /version/)
  })
})

describe('postage selection (pure)', () => {
  const batch = (overrides = {}) => ({
    batchID: { toString: () => 'aa'.repeat(32) },
    usable: true,
    usageText: '0%',
    duration: { toSeconds: () => 86400 },
    remainingSize: { toBytes: () => 1000 },
    ...overrides,
  })

  it('selects first usable batch with space', () => {
    const full = batch({ remainingSize: { toBytes: () => 0 } })
    const good = batch()
    assert.equal(selectUsableBatch([full, good]), good)
  })

  it('returns undefined when no usable batch exists', () => {
    assert.equal(selectUsableBatch([]), undefined)
    assert.equal(selectUsableBatch([batch({ usable: false })]), undefined)
  })

  it('finds a batch by id case-insensitively', () => {
    const b = batch()
    assert.equal(findBatchById([b], 'AA'.repeat(32)), b)
    assert.equal(findBatchById([b], 'bb'.repeat(32)), undefined)
  })

  it('summarizes without inventing values', () => {
    const summary = formatBatchSummary(batch())
    assert.match(summary, /usable=true/)
  })
})

describe('feed index resolution (offline doubles)', () => {
  it('falls back to index 0 when the feed has no updates', async () => {
    const reader = {
      downloadReference: async () => {
        const error = new Error('feed not found')
        error.status = 404
        throw error
      },
    }
    const next = await resolveNextIndex(reader)
    assert.equal(next.toBigInt(), zeroIndex().toBigInt())
  })

  it('re-throws genuine Bee errors instead of masking them', async () => {
    const reader = {
      downloadReference: async () => {
        throw new Error('connection refused')
      },
    }
    await assert.rejects(() => resolveNextIndex(reader), /connection refused/)
  })
})

describe('formatters', () => {
  it('formats recovery and status summaries', () => {
    const recovery = formatRecoverySummary({
      reference: 'ab'.repeat(32),
      feedIndex: '3',
      entry: { title: 'Tsering' },
    })
    assert.match(recovery, /feed index 3/)

    const status = formatStatusSummary({
      health: { status: 'ok' },
      readiness: { status: 'ready' },
      nodeInfo: { beeMode: 'full' },
      versions: { beeVersion: '2.8.0', beeApiVersion: '8.1.0' },
      topology: { connected: 12 },
    })
    assert.match(status, /connectedPeers=12/)
  })
})
