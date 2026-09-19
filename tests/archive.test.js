// Archive manifest tests — fully offline, deterministic (node:test).
// Covers: creation, parsing, version validation, deterministic serialization,
// malformed rejection, reference validation, large/multi-chunk fixtures, and
// archive input collection. No Bee node, no network.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ARCHIVE_SCHEMA,
  ARCHIVE_MANIFEST_VERSION,
  ARCHIVE_MANIFEST_NAME,
  buildArchiveManifest,
  parseArchiveManifest,
  isValidSwarmReference,
} from '../src/archive.js'
import { collectArchiveEntries } from '../src/publish.js'

const REF_A = 'aa'.repeat(32)
const REF_B = 'bb'.repeat(32)
const REF_C = 'cc'.repeat(32)
const FIXED_TIME = '2026-03-01T00:00:00.000Z'

function sampleItems() {
  return [
    { id: 'folio-0002', name: 'folio-0002.jpg', size: 20, reference: REF_B },
    { id: 'folio-0001', name: 'folio-0001.jpg', size: 10, reference: REF_A },
  ]
}

describe('archive manifest creation (offline)', () => {
  it('builds a versioned, named manifest with sorted items', () => {
    const raw = buildArchiveManifest({ items: sampleItems(), updatedAt: FIXED_TIME })
    const parsed = JSON.parse(raw)
    assert.equal(parsed.schema, ARCHIVE_SCHEMA)
    assert.equal(parsed.schema, 'tsering-archive')
    assert.equal(parsed.version, ARCHIVE_MANIFEST_VERSION)
    assert.equal(parsed.version, 1)
    assert.equal(parsed.name, ARCHIVE_MANIFEST_NAME)
    assert.equal(parsed.updatedAt, FIXED_TIME)
    assert.deepEqual(
      parsed.items.map((item) => item.id),
      ['folio-0001', 'folio-0002'],
    )
  })

  it('round-trips through parseArchiveManifest', () => {
    const raw = buildArchiveManifest({ items: sampleItems(), updatedAt: FIXED_TIME })
    const parsed = parseArchiveManifest(raw)
    assert.equal(parsed.schema, 'tsering-archive')
    assert.equal(parsed.items.length, 2)
    assert.equal(parsed.items[0].reference, REF_A)
    assert.equal(parsed.items[0].size, 10)
  })

  it('accepts a custom name and keeps size optional', () => {
    const raw = buildArchiveManifest({
      name: 'Custom',
      items: [{ id: 'a', name: 'a.txt', reference: REF_C }],
      updatedAt: FIXED_TIME,
    })
    const parsed = parseArchiveManifest(raw)
    assert.equal(parsed.name, 'Custom')
    assert.equal(parsed.items[0].size, undefined)
  })
})

describe('deterministic serialization (offline)', () => {
  it('produces byte-identical output for identical input', () => {
    const a = buildArchiveManifest({ items: sampleItems(), updatedAt: FIXED_TIME })
    const b = buildArchiveManifest({ items: sampleItems(), updatedAt: FIXED_TIME })
    assert.equal(a, b)
  })

  it('is insensitive to input item order (sorted by id)', () => {
    const forward = buildArchiveManifest({ items: sampleItems(), updatedAt: FIXED_TIME })
    const reversed = buildArchiveManifest({ items: [...sampleItems()].reverse(), updatedAt: FIXED_TIME })
    assert.equal(forward, reversed)
  })
})

describe('manifest version validation (offline)', () => {
  it('rejects an unsupported version', () => {
    const raw = JSON.stringify({
      schema: 'tsering-archive',
      version: 99,
      name: 'X',
      updatedAt: FIXED_TIME,
      items: [{ id: 'a', name: 'a', reference: REF_A }],
    })
    assert.throws(() => parseArchiveManifest(raw), /version/)
  })

  it('rejects a wrong schema', () => {
    const raw = JSON.stringify({
      schema: 'something-else',
      version: 1,
      name: 'X',
      updatedAt: FIXED_TIME,
      items: [{ id: 'a', name: 'a', reference: REF_A }],
    })
    assert.throws(() => parseArchiveManifest(raw), /schema/)
  })

  it('rejects a build with an empty items array', () => {
    assert.throws(() => buildArchiveManifest({ items: [], updatedAt: FIXED_TIME }), /non-empty/)
  })
})

describe('malformed manifest rejection (offline)', () => {
  it('rejects non-JSON input', () => {
    assert.throws(() => parseArchiveManifest('not json{{'), /valid JSON/)
  })

  it('rejects missing name/updatedAt/items', () => {
    const base = { schema: 'tsering-archive', version: 1 }
    assert.throws(
      () => parseArchiveManifest(JSON.stringify({ ...base, updatedAt: FIXED_TIME, items: [{ id: 'a', name: 'a', reference: REF_A }] })),
      /name/,
    )
    assert.throws(
      () => parseArchiveManifest(JSON.stringify({ ...base, name: 'X', items: [{ id: 'a', name: 'a', reference: REF_A }] })),
      /updatedAt/,
    )
    assert.throws(
      () => parseArchiveManifest(JSON.stringify({ ...base, name: 'X', updatedAt: FIXED_TIME })),
      /items/,
    )
    assert.throws(
      () => parseArchiveManifest(JSON.stringify({ ...base, name: 'X', updatedAt: FIXED_TIME, items: [] })),
      /non-empty/,
    )
  })

  it('rejects items with bad id/name/reference/size', () => {
    assert.throws(() => buildArchiveManifest({ items: [{ name: 'a', reference: REF_A }], updatedAt: FIXED_TIME }), /id/)
    assert.throws(() => buildArchiveManifest({ items: [{ id: 'a', reference: REF_A }], updatedAt: FIXED_TIME }), /name/)
    assert.throws(() => buildArchiveManifest({ items: [{ id: 'a', name: 'a', reference: 'xyz' }], updatedAt: FIXED_TIME }), /reference/)
    assert.throws(
      () => buildArchiveManifest({ items: [{ id: 'a', name: 'a', reference: REF_A, size: -1 }], updatedAt: FIXED_TIME }),
      /size/,
    )
  })

  it('rejects duplicate item ids on build and parse', () => {
    const dupes = [
      { id: 'same', name: 'one.txt', reference: REF_A },
      { id: 'same', name: 'two.txt', reference: REF_B },
    ]
    assert.throws(() => buildArchiveManifest({ items: dupes, updatedAt: FIXED_TIME }), /duplicate/)
    const raw = JSON.stringify({ schema: 'tsering-archive', version: 1, name: 'X', updatedAt: FIXED_TIME, items: dupes })
    assert.throws(() => parseArchiveManifest(raw), /duplicate/)
  })

  it('rejects an invalid updatedAt timestamp', () => {
    assert.throws(() => buildArchiveManifest({ items: sampleItems(), updatedAt: 'not-a-date' }), /updatedAt/)
  })
})

describe('swarm reference validation (offline)', () => {
  it('accepts 64-hex (unencrypted) references', () => {
    assert.equal(isValidSwarmReference(REF_A), true)
    assert.equal(isValidSwarmReference(REF_A.toUpperCase()), true)
  })

  it('accepts 128-hex (encrypted) references', () => {
    assert.equal(isValidSwarmReference('ab'.repeat(64)), true)
  })

  it('rejects short, non-hex, and empty references', () => {
    assert.equal(isValidSwarmReference('aa'.repeat(31)), false)
    assert.equal(isValidSwarmReference('zz'.repeat(32)), false)
    assert.equal(isValidSwarmReference(''), false)
    assert.equal(isValidSwarmReference(undefined), false)
    assert.equal(isValidSwarmReference(42), false)
  })

  it('never invents references: build requires one per item', () => {
    assert.throws(() => buildArchiveManifest({ items: [{ id: 'a', name: 'a' }], updatedAt: FIXED_TIME }), /reference/)
  })
})

describe('large / multi-chunk fixture handling (offline)', () => {
  // A Swarm chunk carries ~4 KiB. The manifest below is deliberately built
  // with enough items to exceed one chunk, proving the reference path is
  // exercised by architecture (feed stores 32 bytes, not the manifest).
  it('builds a manifest larger than one Swarm chunk (~4 KiB)', () => {
    const items = Array.from({ length: 60 }, (_, i) => ({
      id: `folio-${String(i).padStart(4, '0')}`,
      name: `folio-${String(i).padStart(4, '0')}.jpg`,
      size: 4096 + i,
      reference: (i % 2 === 0 ? 'ab' : 'cd').repeat(32),
    }))
    const raw = buildArchiveManifest({ items, updatedAt: FIXED_TIME })
    assert.ok(raw.length > 4096, `expected multi-chunk manifest, got ${raw.length} bytes`)
    const parsed = parseArchiveManifest(raw)
    assert.equal(parsed.items.length, 60)
  })

  it('handles large deterministic item content sizes in metadata', () => {
    const bigSize = 3 * 4096 + 100 // > 3 chunks of raw file bytes
    const raw = buildArchiveManifest({
      items: [{ id: 'folio-big', name: 'folio-big.jpg', size: bigSize, reference: REF_A }],
      updatedAt: FIXED_TIME,
    })
    assert.equal(parseArchiveManifest(raw).items[0].size, bigSize)
  })
})

describe('archive input collection (offline, temp filesystem)', () => {
  it('collects a single file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsering-'))
    const file = join(dir, 'folio-0001.txt')
    writeFileSync(file, 'folio one')
    const entries = collectArchiveEntries(file)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].name, 'folio-0001.txt')
    assert.equal(Buffer.from(entries[0].data).toString(), 'folio one')
  })

  it('collects directory files sorted by name (deterministic order)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsering-'))
    writeFileSync(join(dir, 'b.txt'), 'B')
    writeFileSync(join(dir, 'a.txt'), 'A')
    mkdirSync(join(dir, 'subdir'))
    const entries = collectArchiveEntries(dir)
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ['a.txt', 'b.txt'],
    )
  })

  it('rejects missing paths, empty input, empty directories, and empty files', () => {
    assert.throws(() => collectArchiveEntries(''), /non-empty/)
    assert.throws(() => collectArchiveEntries(join(tmpdir(), 'tsering-does-not-exist-xyz')), /does not exist/)
    const emptyDir = mkdtempSync(join(tmpdir(), 'tsering-empty-'))
    assert.throws(() => collectArchiveEntries(emptyDir), /no files/)
    const dir = mkdtempSync(join(tmpdir(), 'tsering-'))
    writeFileSync(join(dir, 'empty.txt'), '')
    assert.throws(() => collectArchiveEntries(join(dir, 'empty.txt')), /empty/)
  })
})
