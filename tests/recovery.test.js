// Independent stranger recovery tests.
// Offline doubles run for real (PASS/FAIL) against a simulated Swarm
// network: a content-addressed chunk store + a feed pointer table. The
// publish side and the stranger side get SEPARATE client objects sharing
// only that network store plus the public { owner, topic } identifiers —
// the delete-the-app story, honestly simulated.
// Anything needing a live Bee node SKIPS as BLOCKED, never fake-PASS.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FeedIndex } from '@ethersphere/bee-js'
import {
  recoverArchive,
  recoverArchiveToDirectory,
  safeOutputPath,
  parseRecoveryIdentifier,
} from '../src/recovery.js'
import { buildArchiveManifest } from '../src/archive.js'
import { publishArchive } from '../src/publish.js'
import { loadConfig } from '../src/config.js'
import { createBeeClient } from '../src/bee.js'
import { loadFeedIdentity } from '../src/feed.js'

const OWNER = '0x' + 'ab'.repeat(20)
const TOPIC = 'tsering-archive-v1'
const BATCH_HEX = 'ab'.repeat(32)
const FIXED_TIME = '2026-03-01T00:00:00.000Z'

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function notFoundError() {
  const error = new Error('Not Found')
  error.status = 404
  return error
}

// ---- Simulated Swarm network -------------------------------------------
// chunks: ref -> Buffer (the content-addressed Swarm store)
// history: ordered feed updates (the network's sequencing, NOT app state)
function createNetwork() {
  return { chunks: new Map(), history: [] }
}

function feedResult(entry) {
  return {
    reference: { toHex: () => entry.reference },
    feedIndex: FeedIndex.fromBigInt(entry.feedIndex),
    feedIndexNext: FeedIndex.fromBigInt(entry.feedIndexNext),
  }
}

// Publisher-side client: writes chunks + appends the feed pointer.
function publishSideBee(network) {
  const batch = {
    batchID: { toString: () => BATCH_HEX },
    usable: true,
    remainingSize: { toBytes: () => 1_000_000 },
  }
  return {
    stamp: { getAll: async () => [batch] },
    data: {
      upload: async (_batchId, data) => {
        const bytes = Buffer.from(typeof data === 'string' ? data : data)
        const ref = sha256Hex(bytes)
        network.chunks.set(ref, bytes)
        return { reference: { toHex: () => ref } }
      },
    },
    feed: {
      makeWriter: () => ({
        uploadReference: async (_batchId, reference) => {
          const index = BigInt(network.history.length)
          network.history.push({ reference, feedIndex: index, feedIndexNext: index + 1n })
          return { reference: { toHex: () => 'ee'.repeat(32) } }
        },
      }),
      makeReader: () => ({
        downloadReference: async () => {
          if (network.history.length === 0) throw notFoundError()
          return feedResult(network.history[network.history.length - 1])
        },
      }),
    },
  }
}

// Stranger-side client: a FRESH object, reads only, no key, no postage.
function strangerBee(network, { missingRefs = new Set() } = {}) {
  const requested = []
  return {
    requested,
    feed: {
      makeReader: () => ({
        downloadReference: async () => {
          if (network.history.length === 0) throw notFoundError()
          return feedResult(network.history[network.history.length - 1])
        },
      }),
    },
    data: {
      download: async (reference) => {
        const key = String(reference).toLowerCase()
        requested.push(key)
        if (missingRefs.has(key)) throw new Error('simulated chunk loss')
        const bytes = network.chunks.get(key)
        if (!bytes) throw new Error(`chunk not found: ${key}`)
        return bytes
      },
    },
  }
}

// Seed a manifest straight into the network (offline fixture setup only).
function seedManifest(network, manifestText) {
  const bytes = Buffer.from(manifestText, 'utf8')
  const ref = sha256Hex(bytes)
  network.chunks.set(ref, bytes)
  network.history.push({ reference: ref, feedIndex: 0n, feedIndexNext: 1n })
  return ref
}

function seedItems(network, files) {
  return Object.entries(files).map(([name, content]) => {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content)
    const reference = sha256Hex(bytes)
    network.chunks.set(reference, bytes)
    return { id: name, name, size: bytes.byteLength, reference }
  })
}

function withStrangerEnv(fn) {
  const saved = process.env.FEED_PRIVATE_KEY
  delete process.env.FEED_PRIVATE_KEY
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (saved !== undefined) process.env.FEED_PRIVATE_KEY = saved
    })
}

describe('empty feed (offline)', () => {
  it('rejects an empty feed with a clear no-publication message', async () => {
    const bee = strangerBee(createNetwork())
    await assert.rejects(
      () => recoverArchive({ bee, owner: OWNER, topic: TOPIC }),
      /Feed is empty — no archive has been published yet/,
    )
  })

  it('rejects invalid owner/topic before any network call', async () => {
    const bee = strangerBee(createNetwork())
    let calls = 0
    bee.feed.makeReader = () => {
      calls += 1
      throw new Error('must not be called')
    }
    await assert.rejects(() => recoverArchive({ bee, owner: 'xyz', topic: TOPIC }), /owner/)
    await assert.rejects(() => recoverArchive({ bee, owner: OWNER, topic: '' }), /topic/)
    assert.equal(calls, 0)
  })
})

describe('manifest recovery (offline)', () => {
  it('recovers owner/topic/archiveReference/manifest through the feed only', async () => {
    const network = createNetwork()
    const items = seedItems(network, { 'folio-0001.txt': 'Testimony one.', 'folio-0002.txt': 'Testimony two.' })
    const manifestRef = seedManifest(network, buildArchiveManifest({ items, updatedAt: FIXED_TIME }))
    const bee = strangerBee(network)
    const result = await recoverArchive({ bee, owner: OWNER, topic: TOPIC })
    assert.equal(result.owner, OWNER)
    assert.equal(result.topic, TOPIC)
    assert.equal(result.archiveReference, manifestRef)
    assert.equal(result.feedIndex, '0')
    assert.equal(result.manifest.schema, 'tsering-archive')
    assert.equal(result.manifest.version, 1)
    assert.equal(result.items.length, 2)
  })

  it('propagates Bee failures with the stage identified', async () => {
    const bee = strangerBee(createNetwork())
    bee.feed.makeReader = () => ({
      downloadReference: async () => {
        throw new Error('connection refused')
      },
    })
    await assert.rejects(() => recoverArchive({ bee, owner: OWNER, topic: TOPIC }), /Feed resolution failed/)
  })
})

describe('malformed manifest rejection (offline)', () => {
  async function recoverSeeded(manifestText) {
    const network = createNetwork()
    const ref = seedManifest(network, manifestText)
    const result = await recoverArchive({ bee: strangerBee(network), owner: OWNER, topic: TOPIC }).then(
      (ok) => ({ ok }),
      (error) => ({ error, ref }),
    )
    return result
  }

  it('rejects non-JSON manifests', async () => {
    const { error } = await recoverSeeded('not json{{')
    assert.match(error.message, /invalid/)
  })

  it('rejects wrong schema and unsupported versions', async () => {
    const badSchema = await recoverSeeded(
      JSON.stringify({ schema: 'nope', version: 1, name: 'X', updatedAt: FIXED_TIME, items: [] }),
    )
    assert.match(badSchema.error.message, /invalid/)
    const badVersion = await recoverSeeded(
      JSON.stringify({ schema: 'tsering-archive', version: 99, name: 'X', updatedAt: FIXED_TIME, items: [] }),
    )
    assert.match(badVersion.error.message, /version/)
  })

  it('rejects manifests with empty items', async () => {
    const { error } = await recoverSeeded(
      JSON.stringify({ schema: 'tsering-archive', version: 1, name: 'X', updatedAt: FIXED_TIME, items: [] }),
    )
    assert.match(error.message, /non-empty/)
  })
})

describe('bad item references (offline)', () => {
  it('rejects a manifest carrying an invalid Swarm reference', async () => {
    const network = createNetwork()
    seedManifest(
      network,
      JSON.stringify({
        schema: 'tsering-archive',
        version: 1,
        name: 'X',
        updatedAt: FIXED_TIME,
        items: [{ id: 'evil', name: 'evil.txt', reference: 'xyz' }],
      }),
    )
    await assert.rejects(
      () => recoverArchive({ bee: strangerBee(network), owner: OWNER, topic: TOPIC }),
      /reference/,
    )
  })

  it('fails the folio stage (with partial progress) when an item chunk is missing', async () => {
    const network = createNetwork()
    const items = seedItems(network, { 'a.txt': 'A', 'b.txt': 'B' })
    seedManifest(network, buildArchiveManifest({ items, updatedAt: FIXED_TIME }))
    const missing = new Set([items[1].reference])
    const error = await recoverArchive({ bee: strangerBee(network, { missingRefs: missing }), owner: OWNER, topic: TOPIC }).then(
      () => { throw new Error('expected folio failure') },
      (failure) => failure,
    )
    assert.match(error.message, /Folio download failed for item "b.txt"/)
    assert.deepEqual(error.partial.recoveredItems, ['a.txt'])
  })
})

describe('every folio is retrieved and verified (offline)', () => {
  it('requests the manifest plus each item ref exactly once, in order', async () => {
    const network = createNetwork()
    const items = seedItems(network, { 'a.txt': 'A', 'b.txt': 'B', 'c.txt': 'C' })
    const manifestRef = seedManifest(network, buildArchiveManifest({ items, updatedAt: FIXED_TIME }))
    const bee = strangerBee(network)
    const progress = []
    const result = await recoverArchive({ bee, owner: OWNER, topic: TOPIC, onItem: (event) => progress.push(event) })
    assert.deepEqual(bee.requested, [manifestRef, ...items.map((item) => item.reference)])
    assert.deepEqual(
      progress.map((event) => event.id),
      ['a.txt', 'b.txt', 'c.txt'],
    )
    assert.deepEqual(
      result.items.map((item) => [item.id, item.name, item.reference, item.size]),
      items.map((item) => [item.id, item.name, item.reference, item.size]),
    )
    for (const item of result.items) {
      const original = network.chunks.get(item.reference)
      assert.deepEqual(Buffer.from(item.data), original)
      assert.equal(item.digest, sha256Hex(original))
      assert.match(item.digest, /^[0-9a-f]{64}$/)
    }
  })

  it('rejects a size mismatch between manifest and downloaded bytes', async () => {
    const network = createNetwork()
    const bytes = Buffer.from('tampered!')
    const reference = sha256Hex(bytes)
    network.chunks.set(reference, bytes)
    seedManifest(
      network,
      JSON.stringify({
        schema: 'tsering-archive',
        version: 1,
        name: 'X',
        updatedAt: FIXED_TIME,
        items: [{ id: 'a', name: 'a.txt', size: 1, reference }],
      }),
    )
    await assert.rejects(
      () => recoverArchive({ bee: strangerBee(network), owner: OWNER, topic: TOPIC }),
      /size mismatch/,
    )
  })
})

describe('no private key, no local state (offline)', () => {
  it('recovery source never touches secrets, postage, or local stores', async () => {
    const source = readFileSync(new URL('../src/recovery.js', import.meta.url), 'utf8')
    // Strip comments: documentation may legitimately NAME things recovery
    // avoids ("never loads FEED_PRIVATE_KEY", "no feed.json/localStorage").
    // What matters is the executable code underneath.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1')
    for (const forbidden of [
      'process.env',
      'loadConfig',
      'new PrivateKey',
      'makeWriter',
      'POSTAGE_BATCH_ID',
      'postageBatchId',
      'bee.stamp',
      'getAll(',
      'localStorage',
      'loadFeedIdentity',
      'feed.json',
      'uploadReference(',
      'uploadPayload',
      'index++',
      'getItem',
      'setItem',
    ]) {
      assert.ok(!code.includes(forbidden), `src/recovery.js code must not contain ${JSON.stringify(forbidden)}`)
    }
    // 'FEED_PRIVATE_KEY' as a string literal is legitimate code ONLY inside
    // the guard rejecting key-smuggling identifiers — verify exactly that.
    assert.ok(code.includes("'FEED_PRIVATE_KEY' in input"), 'recovery must guard against key-smuggling')
    assert.ok(source.includes('never include a private key'), 'recovery must document key rejection')
  })

  it('recovers with FEED_PRIVATE_KEY removed from the environment', async () => {
    const network = createNetwork()
    const items = seedItems(network, { 'folio-0001.txt': 'No key needed.' })
    seedManifest(network, buildArchiveManifest({ items, updatedAt: FIXED_TIME }))
    await withStrangerEnv(async () => {
      assert.equal(process.env.FEED_PRIVATE_KEY, undefined)
      const result = await recoverArchive({ bee: strangerBee(network), owner: OWNER, topic: TOPIC })
      assert.equal(Buffer.from(result.items[0].data).toString(), 'No key needed.')
    })
  })

  it('recovers from an empty working directory with no archive or state present', async () => {
    const network = createNetwork()
    const items = seedItems(network, { 'folio-0001.txt': 'Stateless.' })
    seedManifest(network, buildArchiveManifest({ items, updatedAt: FIXED_TIME }))
    const emptyCwd = mkdtempSync(join(tmpdir(), 'tsering-stranger-'))
    const outdir = join(emptyCwd, 'out')
    await withStrangerEnv(async () => {
      const result = await recoverArchiveToDirectory({ bee: strangerBee(network), owner: OWNER, topic: TOPIC, outputDir: outdir })
      assert.equal(result.recoveredCount, 1)
      assert.equal(readFileSync(join(outdir, 'folio-0001.txt'), 'utf8'), 'Stateless.')
    })
  })
})

describe('recovery identifier parsing (offline)', () => {
  it('accepts object, space-separated, slash-separated, and JSON forms', () => {
    assert.deepEqual(parseRecoveryIdentifier({ owner: OWNER, topic: TOPIC }), { owner: OWNER, topic: TOPIC })
    assert.deepEqual(parseRecoveryIdentifier(`${OWNER} ${TOPIC}`), { owner: OWNER, topic: TOPIC })
    assert.deepEqual(parseRecoveryIdentifier(`${OWNER}/${TOPIC}`), { owner: OWNER, topic: TOPIC })
    assert.deepEqual(parseRecoveryIdentifier(JSON.stringify({ owner: OWNER, topic: TOPIC })), { owner: OWNER, topic: TOPIC })
  })

  it('rejects identifiers smuggling a private key', () => {
    assert.throws(() => parseRecoveryIdentifier({ owner: OWNER, topic: TOPIC, privateKey: '0x123' }), /never include a private key/)
  })

  it('rejects malformed identifiers', () => {
    assert.throws(() => parseRecoveryIdentifier('onlyowner'), /form/)
    assert.throws(() => parseRecoveryIdentifier(''), /must be/)
    assert.throws(() => parseRecoveryIdentifier('{nope'), /valid JSON/)
  })
})

describe('path traversal protection (offline)', () => {
  const OUT = join(tmpdir(), 'tsering-out-check')

  it('rejects absolute paths, parent escapes, and sneaky nesting', () => {
    for (const evil of ['../secret.txt', '../../secret.txt', '/absolute/path', 'a/../../evil.txt', '..', '']) {
      assert.throws(() => safeOutputPath(OUT, evil), /Refusing/, `expected rejection of ${JSON.stringify(evil)}`)
    }
  })

  it('accepts confined names, including a relative subdirectory', () => {
    assert.ok(safeOutputPath(OUT, 'folio-0001.txt').startsWith(OUT))
    assert.ok(safeOutputPath(OUT, 'sub/folio.txt').startsWith(OUT))
  })

  it('never writes outside the output directory for a malicious manifest', async () => {
    const network = createNetwork()
    const evilBytes = Buffer.from('escape attempt')
    const evilRef = sha256Hex(evilBytes)
    network.chunks.set(evilRef, evilBytes)
    seedManifest(
      network,
      JSON.stringify({
        schema: 'tsering-archive',
        version: 1,
        name: 'X',
        updatedAt: FIXED_TIME,
        items: [{ id: 'evil', name: '../evil.txt', size: evilBytes.byteLength, reference: evilRef }],
      }),
    )
    const outdir = mkdtempSync(join(tmpdir(), 'tsering-traversal-'))
    await assert.rejects(
      () => recoverArchiveToDirectory({ bee: strangerBee(network), owner: OWNER, topic: TOPIC, outputDir: outdir }),
      /Refusing/,
    )
    assert.deepEqual(readdirSync(outdir), [])
  })

  it('refuses to silently overwrite existing files', async () => {
    const network = createNetwork()
    const items = seedItems(network, { 'keep.txt': 'network version' })
    seedManifest(network, buildArchiveManifest({ items, updatedAt: FIXED_TIME }))
    const outdir = mkdtempSync(join(tmpdir(), 'tsering-overwrite-'))
    writeFileSync(join(outdir, 'keep.txt'), 'local version')
    await assert.rejects(
      () => recoverArchiveToDirectory({ bee: strangerBee(network), owner: OWNER, topic: TOPIC, outputDir: outdir }),
      /overwrite/,
    )
    assert.equal(readFileSync(join(outdir, 'keep.txt'), 'utf8'), 'local version')
    const retry = await recoverArchiveToDirectory({
      bee: strangerBee(network),
      owner: OWNER,
      topic: TOPIC,
      outputDir: outdir,
      overwrite: true,
    })
    assert.equal(retry.recoveredCount, 1)
    assert.equal(readFileSync(join(outdir, 'keep.txt'), 'utf8'), 'network version')
  })
})

describe('multi-file archive reconstruction (offline)', () => {
  it('recovers text, binary, and multi-chunk folios byte-exact', async () => {
    const binary = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256))
    const big = `line\n`.repeat(1500) // > 4 KiB: exercises the chunked path by size
    const network = createNetwork()
    const items = seedItems(network, {
      'folio-0001.txt': 'First testimony.',
      'folio 0002.txt': 'Second testimony, with spaces in the name.',
      'folio-0003.bin': binary,
      'folio-0004-big.txt': big,
    })
    seedManifest(network, buildArchiveManifest({ items, updatedAt: FIXED_TIME }))
    const outdir = mkdtempSync(join(tmpdir(), 'tsering-multi-'))
    const result = await recoverArchiveToDirectory({ bee: strangerBee(network), owner: OWNER, topic: TOPIC, outputDir: outdir })
    assert.equal(result.recoveredCount, 4)
    assert.equal(result.files.length, 4)
    assert.equal(readFileSync(join(outdir, 'folio-0001.txt'), 'utf8'), 'First testimony.')
    assert.equal(readFileSync(join(outdir, 'folio 0002.txt'), 'utf8'), 'Second testimony, with spaces in the name.')
    assert.deepEqual(readFileSync(join(outdir, 'folio-0003.bin')), binary)
    assert.equal(readFileSync(join(outdir, 'folio-0004-big.txt'), 'utf8'), big)
  })
})

describe('delete-the-app: publish, erase everything, recover as a stranger (offline)', () => {
  it('recovers every folio from owner + topic + network only', async () => {
    const network = createNetwork()
    const originals = {
      'folio-0001.txt': 'Tsering testimony, folio one.',
      'folio-0002.txt': 'Tsering testimony, folio two.',
      'folio-0003.bin': Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7) % 256)),
    }
    const archiveDir = mkdtempSync(join(tmpdir(), 'tsering-original-'))
    for (const [name, content] of Object.entries(originals)) {
      writeFileSync(join(archiveDir, name), content)
    }

    // 1. Publish (publisher credentials exist only in THIS scope).
    const published = await publishArchive({
      bee: publishSideBee(network),
      archivePath: archiveDir,
      postageBatchId: BATCH_HEX,
      topic: TOPIC,
      owner: OWNER,
      privateKey: '0x' + '11'.repeat(32),
      updatedAt: FIXED_TIME,
    })
    assert.equal(published.itemCount, 3)

    // 2-5. Keep ONLY the public identifiers. Delete the original archive,
    // local state, and the private key. The stranger gets a FRESH client.
    const publicOwner = TOPIC && OWNER
    const publicTopic = TOPIC
    rmSync(archiveDir, { recursive: true, force: true })
    assert.ok(!readdirSync(tmpdir()).includes(archiveDir))
    const stranger = strangerBee(network)
    assert.notEqual(stranger, undefined)

    await withStrangerEnv(async () => {
      // 6. Recover using only owner + topic + Bee.
      const result = await recoverArchive({ bee: stranger, owner: publicOwner, topic: publicTopic })
      // 7. Verify every folio.
      assert.equal(result.archiveReference, published.archiveReference)
      assert.equal(result.items.length, 3)
      for (const item of result.items) {
        const expected = Buffer.isBuffer(originals[item.name])
          ? originals[item.name]
          : Buffer.from(originals[item.name])
        assert.deepEqual(Buffer.from(item.data), expected, `folio mismatch: ${item.name}`)
        assert.equal(item.size, expected.byteLength)
        assert.equal(item.digest, sha256Hex(expected))
        const manifestEntry = result.manifest.items.find((entry) => entry.id === item.id)
        assert.equal(item.reference, manifestEntry.reference)
      }
      const outdir = mkdtempSync(join(tmpdir(), 'tsering-stranger-out-'))
      const files = await recoverArchiveToDirectory({ bee: strangerBee(network), owner: publicOwner, topic: publicTopic, outputDir: outdir })
      assert.equal(files.recoveredCount, 3)
      for (const [name, content] of Object.entries(originals)) {
        const expected = Buffer.isBuffer(content) ? content : Buffer.from(content)
        assert.deepEqual(readFileSync(join(outdir, name)), expected)
      }
    })
  })
})

describe('live stranger recovery (gated — BLOCKED without Bee)', () => {
  async function liveBee(t) {
    const { beeApiUrl } = loadConfig()
    const bee = createBeeClient(beeApiUrl)
    try {
      await bee.status.getHealth()
    } catch {
      t.skip(`BLOCKED — Bee unreachable at ${beeApiUrl}`)
      return undefined
    }
    return bee
  }

  it('BLOCKED unless Bee answers: recovers the live archive end-to-end', async (t) => {
    const bee = await liveBee(t)
    if (!bee) return
    const identity = loadFeedIdentity()
    let result
    try {
      result = await recoverArchive({ bee, owner: identity.owner, topic: identity.topic })
    } catch (error) {
      if (String(error?.message ?? '').startsWith('Feed is empty')) {
        t.skip('BLOCKED — feed has no published archive')
        return
      }
      throw error
    }
    t.assert.equal(result.manifest.schema, 'tsering-archive')
    t.assert.ok(result.items.length > 0, 'expected at least one folio')
    for (const item of result.items) {
      t.assert.ok(item.data.byteLength > 0, `empty bytes for ${item.id}`)
      if (result.manifest.items.find((entry) => entry.id === item.id)?.size !== undefined) {
        t.assert.equal(item.data.byteLength, result.manifest.items.find((entry) => entry.id === item.id).size)
      }
    }
    t.diagnostic(`Recovered ${result.items.length}/${result.items.length} folios from ${result.archiveReference}`)
  })

  it('BLOCKED unless explicitly enabled: live delete-the-app cycle', async (t) => {
    const bee = await liveBee(t)
    if (!bee) return
    const { feedPrivateKey, postageBatchId } = loadConfig()
    if (!feedPrivateKey || !postageBatchId) {
      t.skip('BLOCKED — no live publication available (FEED_PRIVATE_KEY/POSTAGE_BATCH_ID unset)')
      return
    }
    if (process.env.TSERING_LIVE_RECOVERY !== '1') {
      t.skip('BLOCKED — live delete-the-app mutates the shared dev feed — re-run with TSERING_LIVE_RECOVERY=1 to verify for real')
      return
    }
    const identity = loadFeedIdentity()
    const originals = {
      'live-folio-1.txt': `Live folio one ${new Date().toISOString()}`,
      'live-folio-2.txt': `Live folio two ${new Date().toISOString()}`,
    }
    const archiveDir = mkdtempSync(join(tmpdir(), 'tsering-live-orig-'))
    for (const [name, content] of Object.entries(originals)) {
      writeFileSync(join(archiveDir, name), content)
    }
    await publishArchive({
      bee,
      archivePath: archiveDir,
      postageBatchId,
      topic: identity.topic,
      owner: identity.owner,
      privateKey: feedPrivateKey,
    })
    // Delete the app: originals gone, fresh client, owner + topic only.
    rmSync(archiveDir, { recursive: true, force: true })
    const stranger = createBeeClient(loadConfig().beeApiUrl)
    const outdir = mkdtempSync(join(tmpdir(), 'tsering-live-out-'))
    const result = await recoverArchiveToDirectory({ bee: stranger, owner: identity.owner, topic: identity.topic, outputDir: outdir })
    t.assert.ok(result.items.length >= 2, 'expected the just-published folios')
    for (const [name, content] of Object.entries(originals)) {
      t.assert.equal(readFileSync(join(outdir, name), 'utf8'), content)
    }
    t.diagnostic(`Live delete-the-app recovered ${result.recoveredCount} folios`)
  })
})
