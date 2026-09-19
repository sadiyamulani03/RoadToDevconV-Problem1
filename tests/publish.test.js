// Archive publication tests.
// Offline doubles run for real (PASS/FAIL). Anything needing a live Bee node
// SKIPS with an explicit BLOCKED message instead of pretending PASS.
// Run with: npm test
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FeedIndex } from '@ethersphere/bee-js'
import {
  resolvePublishBatchId,
  uploadArchiveContent,
  publishArchive,
  updateArchive,
  NO_POSTAGE_MESSAGE,
} from '../src/publish.js'
import { parseArchiveManifest } from '../src/archive.js'
import { loadConfig } from '../src/config.js'
import { createBeeClient } from '../src/bee.js'
import { loadFeedIdentity, readLatestEntry } from '../src/feed.js'

const BATCH_HEX = 'ab'.repeat(32)

function usableBatch(overrides = {}) {
  return {
    batchID: { toString: () => BATCH_HEX },
    usable: true,
    usageText: '0%',
    duration: { toSeconds: () => 86400 },
    remainingSize: { toBytes: () => 1_000_000 },
    ...overrides,
  }
}

// Offline double for Bee: content-addressed by sha256 (valid-format fake
// refs, clearly test-only), feed writer captures its args so tests can
// prove the feed receives a reference — never archive bytes.
function mockBee({ batches = [usableBatch()], failOnUploadAt } = {}) {
  const uploads = []
  const store = new Map()
  let uploadCalls = 0
  let seenFeedArgs
  return {
    uploads,
    get seenFeedArgs() {
      return seenFeedArgs
    },
    stamp: {
      getAll: async () => batches,
    },
    data: {
      upload: async (batchId, data) => {
        uploadCalls += 1
        if (failOnUploadAt !== undefined && uploadCalls === failOnUploadAt) {
          throw new Error('simulated upload failure')
        }
        const bytes = Buffer.from(typeof data === 'string' ? data : data)
        const ref = createHash('sha256').update(bytes).digest('hex')
        uploads.push({ batchId, bytes })
        store.set(ref, bytes)
        return { reference: { toHex: () => ref } }
      },
      download: async (reference) => {
        const bytes = store.get(String(reference).toLowerCase())
        if (!bytes) throw new Error('not found')
        return bytes
      },
    },
    feed: {
      makeWriter: () => ({
        uploadReference: async (...args) => {
          seenFeedArgs = args
          return { reference: { toHex: () => 'ee'.repeat(32) } }
        },
      }),
      makeReader: () => ({
        downloadReference: async () => ({
          reference: { toHex: () => 'ee'.repeat(32) },
          feedIndex: FeedIndex.fromBigInt(4n),
          feedIndexNext: FeedIndex.fromBigInt(5n),
        }),
      }),
    },
  }
}

function tempArchive(files) {
  const dir = mkdtempSync(join(tmpdir(), 'tsering-pub-'))
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content)
  }
  return dir
}

describe('postage resolution for publishing (offline doubles)', () => {
  it('uses the configured batch when it is usable', async () => {
    const bee = mockBee()
    assert.equal(await resolvePublishBatchId(bee, BATCH_HEX), BATCH_HEX)
  })

  it('rejects a configured batch missing from the node (no invention)', async () => {
    const bee = mockBee({ batches: [] })
    await assert.rejects(() => resolvePublishBatchId(bee, BATCH_HEX), /not found/)
  })

  it('rejects a configured batch that is not usable', async () => {
    const bee = mockBee({ batches: [usableBatch({ usable: false })] })
    await assert.rejects(() => resolvePublishBatchId(bee, BATCH_HEX), /not usable/)
  })

  it('auto-selects a usable batch when none is configured', async () => {
    const bee = mockBee()
    assert.equal(await resolvePublishBatchId(bee, undefined), BATCH_HEX)
  })

  it('fails clearly when no usable batch exists', async () => {
    const bee = mockBee({ batches: [] })
    await assert.rejects(() => resolvePublishBatchId(bee, undefined), /No usable postage batch/)
    assert.match(NO_POSTAGE_MESSAGE, /Fund a Bee postage batch/)
  })

  it('propagates Bee errors instead of masking them', async () => {
    const bee = { stamp: { getAll: async () => { throw new Error('connection refused') } } }
    await assert.rejects(() => resolvePublishBatchId(bee, undefined), /connection refused/)
  })
})

describe('archive content upload (offline doubles)', () => {
  it('uploads items then the manifest, returning the archive reference', async () => {
    const bee = mockBee()
    const entries = [
      { id: 'a.txt', name: 'a.txt', data: new Uint8Array(Buffer.from('folio A')) },
      { id: 'b.txt', name: 'b.txt', data: new Uint8Array(Buffer.from('folio B')) },
    ]
    const result = await uploadArchiveContent({ bee, batchId: BATCH_HEX, entries, updatedAt: '2026-03-01T00:00:00.000Z' })
    assert.equal(bee.uploads.length, 3) // 2 items + 1 manifest
    assert.match(result.archiveReference, /^[0-9a-f]{64}$/)
    const manifest = parseArchiveManifest(result.manifestText)
    assert.equal(manifest.items.length, 2)
    // Manifest upload carried the exact manifest bytes just built.
    assert.equal(bee.uploads[2].bytes.toString(), result.manifestText)
  })

  it('reports partial state when an item upload fails', async () => {
    const bee = mockBee({ failOnUploadAt: 2 })
    const entries = [
      { id: 'a.txt', name: 'a.txt', data: new Uint8Array(Buffer.from('folio A')) },
      { id: 'b.txt', name: 'b.txt', data: new Uint8Array(Buffer.from('folio B')) },
    ]
    const error = await uploadArchiveContent({ bee, batchId: BATCH_HEX, entries }).then(
      () => { throw new Error('expected upload to fail') },
      (failure) => failure,
    )
    assert.match(error.message, /failed at item/)
    assert.equal(error.partial.uploadedItems.length, 1)
  })

  it('rejects an empty entry list before any network call', async () => {
    const bee = mockBee()
    await assert.rejects(() => uploadArchiveContent({ bee, batchId: BATCH_HEX, entries: [] }), /no entries/)
    assert.equal(bee.uploads.length, 0)
  })
})

describe('feed stores the reference, never archive bytes (offline doubles)', () => {
  it('publishArchive appends only (batchId, 64-hex ref) — no index, no bytes', async () => {
    const bee = mockBee()
    const dir = tempArchive({ 'folio-0001.txt': 'Testimony line one.', 'folio-0002.txt': 'Testimony line two.' })
    const result = await publishArchive({
      bee,
      archivePath: dir,
      postageBatchId: BATCH_HEX,
      topic: 'tsering-archive-v1',
      owner: '0x' + 'ab'.repeat(20),
      privateKey: '0x' + '11'.repeat(32),
      updatedAt: '2026-03-01T00:00:00.000Z',
    })
    assert.match(result.archiveReference, /^[0-9a-f]{64}$/)
    assert.equal(result.itemCount, 2)
    // The ONLY feed write: exactly 2 args (SDK derives the index itself).
    assert.equal(bee.seenFeedArgs.length, 2)
    assert.equal(bee.seenFeedArgs[0], BATCH_HEX)
    assert.equal(bee.seenFeedArgs[1], result.archiveReference)
    // The feed payload is the 32-byte reference, not the archive content:
    // none of the file bytes or manifest text appear in the feed args.
    for (const arg of bee.seenFeedArgs) {
      assert.ok(!String(arg).includes('Testimony'), 'feed must not contain archive bytes')
      assert.ok(!String(arg).includes('tsering-archive'), 'feed must not contain the manifest')
    }
    assert.equal(result.feedIndex, '4')
  })

  it('a multi-chunk manifest still reaches the feed as a single reference', async () => {
    const bee = mockBee()
    const files = {}
    for (let i = 0; i < 60; i += 1) {
      files[`folio-${String(i).padStart(4, '0')}.txt`] = `Testimony body ${i} — ${'x'.repeat(200)}`
    }
    const dir = tempArchive(files)
    const result = await publishArchive({
      bee,
      archivePath: dir,
      postageBatchId: BATCH_HEX,
      topic: 'tsering-archive-v1',
      privateKey: '0x' + '11'.repeat(32),
      updatedAt: '2026-03-01T00:00:00.000Z',
    })
    assert.ok(result.manifestText.length > 4096, `expected multi-chunk manifest, got ${result.manifestText.length}`)
    assert.equal(bee.seenFeedArgs.length, 2)
    assert.equal(bee.seenFeedArgs[1], result.archiveReference)
    assert.equal(result.archiveReference.length, 64)
  })

  it('updateArchive reuses the identical safe-append path', async () => {
    const bee = mockBee()
    const dir = tempArchive({ 'folio-0001.txt': 'v2 testimony' })
    const updated = await updateArchive({
      bee,
      archivePath: dir,
      postageBatchId: BATCH_HEX,
      topic: 'tsering-archive-v1',
      privateKey: '0x' + '11'.repeat(32),
      updatedAt: '2026-03-02T00:00:00.000Z',
    })
    assert.match(updated.archiveReference, /^[0-9a-f]{64}$/)
    assert.equal(bee.seenFeedArgs.length, 2)
    assert.equal(bee.seenFeedArgs[1], updated.archiveReference)
  })

  it('the published manifest is recoverable from its reference alone (offline double)', async () => {
    const bee = mockBee()
    const dir = tempArchive({ 'folio-0001.txt': 'Recover me.' })
    const result = await publishArchive({
      bee,
      archivePath: dir,
      postageBatchId: BATCH_HEX,
      topic: 'tsering-archive-v1',
      privateKey: '0x' + '11'.repeat(32),
      updatedAt: '2026-03-01T00:00:00.000Z',
    })
    // owner + topic -> feed -> archive reference -> manifest, with no
    // access to the publisher's local directory.
    const manifestBytes = await bee.data.download(result.archiveReference)
    const manifest = parseArchiveManifest(manifestBytes.toString())
    assert.equal(manifest.items.length, 1)
    const itemBytes = await bee.data.download(manifest.items[0].reference)
    assert.equal(itemBytes.toString(), 'Recover me.')
  })
})

describe('live archive publication (gated — BLOCKED without Bee)', () => {
  async function liveBee(t) {
    const { beeApiUrl } = loadConfig()
    const bee = createBeeClient(beeApiUrl)
    try {
      await bee.status.getHealth()
    } catch {
      t.skip(`BLOCKED: Bee unreachable at ${beeApiUrl} — archive upload needs a live node.`)
      return undefined
    }
    return bee
  }

  it('BLOCKED unless Bee answers: uploads manifest bytes and reads them back', async (t) => {
    const bee = await liveBee(t)
    if (!bee) return
    const { postageBatchId } = loadConfig()
    let batchId = postageBatchId
    if (!batchId) {
      const { selectUsableBatch } = await import('../src/postage.js')
      const usable = selectUsableBatch(await bee.stamp.getAll())
      if (!usable) {
        t.skip('BLOCKED: no usable postage batch on this Bee node — fund one before publishing.')
        return
      }
      batchId = String(usable.batchID.toString()).toLowerCase()
    }
    const text = JSON.stringify({ hello: 'swarm' })
    const uploaded = await bee.data.upload(batchId, text)
    const ref = uploaded.reference.toHex()
    t.assert.match(ref, /^[0-9a-fA-F]{64}([0-9a-fA-F]{64})?$/)
    const back = await bee.data.download(ref)
    t.assert.equal(back.toUtf8(), text)
  })

  it('BLOCKED unless Bee answers: reads the feed and retrieves the referenced manifest', async (t) => {
    const bee = await liveBee(t)
    if (!bee) return
    const entry = await readLatestEntry(bee, loadFeedIdentity())
    if (entry.status === 'empty') {
      t.skip('BLOCKED: feed is empty — publish an archive first, then re-run for reference retrieval.')
      return
    }
    const manifestBytes = await bee.data.download(entry.reference)
    const manifest = parseArchiveManifest(manifestBytes.toUtf8())
    t.assert.equal(manifest.schema, 'tsering-archive')
  })

  it('BLOCKED unless explicitly enabled: real feed publication (mutates the dev feed)', async (t) => {
    const bee = await liveBee(t)
    if (!bee) return
    const { feedPrivateKey, postageBatchId } = loadConfig()
    if (!feedPrivateKey || !postageBatchId) {
      t.skip('BLOCKED: FEED_PRIVATE_KEY/POSTAGE_BATCH_ID unset — refusing to invent credentials.')
      return
    }
    if (process.env.TSERING_LIVE_PUBLISH !== '1') {
      t.skip('BLOCKED: live publication mutates the shared dev feed — re-run with TSERING_LIVE_PUBLISH=1 to verify for real.')
      return
    }
    const dir = tempArchive({ 'folio-0001.txt': `Live testimony ${new Date().toISOString()}` })
    const result = await publishArchive({
      bee,
      archivePath: dir,
      postageBatchId,
      topic: loadFeedIdentity().topic,
      owner: loadFeedIdentity().owner,
      privateKey: feedPrivateKey,
    })
    t.assert.match(result.archiveReference, /^[0-9a-f]{64}$/)
    t.assert.ok(result.feedIndex !== undefined, 'expected a feed index read-back from live Bee')
  })

  it('BLOCKED unless explicitly enabled: real update publishes a new reference', async (t) => {
    const bee = await liveBee(t)
    if (!bee) return
    const { feedPrivateKey, postageBatchId } = loadConfig()
    if (!feedPrivateKey || !postageBatchId) {
      t.skip('BLOCKED: FEED_PRIVATE_KEY/POSTAGE_BATCH_ID unset — refusing to invent credentials.')
      return
    }
    if (process.env.TSERING_LIVE_PUBLISH !== '1') {
      t.skip('BLOCKED: live update mutates the shared dev feed — re-run with TSERING_LIVE_PUBLISH=1 to verify for real.')
      return
    }
    const dir = tempArchive({ 'folio-0001.txt': `Updated testimony ${new Date().toISOString()}` })
    const result = await updateArchive({
      bee,
      archivePath: dir,
      postageBatchId,
      topic: loadFeedIdentity().topic,
      owner: loadFeedIdentity().owner,
      privateKey: feedPrivateKey,
    })
    t.assert.match(result.archiveReference, /^[0-9a-f]{64}$/)
  })
})
