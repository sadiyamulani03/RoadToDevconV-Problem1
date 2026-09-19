// Feed core tests — offline proofs run for real; anything needing a live
// Bee node SKIPS with an explicit BLOCKED message instead of pretending PASS.
// Run with: npm test
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FeedIndex } from '@ethersphere/bee-js'
import {
  loadFeedIdentity,
  readLatestEntry,
  appendReference,
  resolveNextIndex,
} from '../src/feed.js'
import { loadConfig } from '../src/config.js'
import { createBeeClient } from '../src/bee.js'

function notFoundError() {
  const error = new Error('Not Found')
  error.status = 404
  return error
}

describe('feed identity (offline)', () => {
  it('owner and topic are available from tracked feed.json', () => {
    const identity = loadFeedIdentity()
    assert.equal(identity.topic, 'tsering-archive-v1')
    assert.match(identity.owner, /^(0x)?[0-9a-fA-F]{40}$/)
  })

  it('feed.json contains no private key material', () => {
    const raw = readFileSync(new URL('../feed.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw)
    assert.equal(parsed.privateKey, undefined)
    assert.equal(parsed.feedPrivateKey, undefined)
    assert.equal(/[0-9a-fA-F]{64}/.test(raw), false)
  })

  it('rejects a missing or malformed identity file', () => {
    assert.throws(() => loadFeedIdentity('/nonexistent/feed.json'), /Cannot load feed identity/)
  })
})

describe('empty feed handling (offline doubles)', () => {
  it('readLatestEntry returns { status: empty } instead of crashing', async () => {
    const bee = { feed: { makeReader: () => ({ downloadReference: async () => { throw notFoundError() } }) } }
    const entry = await readLatestEntry(bee, { topic: 't', owner: '0x' + 'ab'.repeat(20) })
    assert.deepEqual(entry, { status: 'empty' })
  })

  it('readLatestEntry returns the found entry with network indexes', async () => {
    const bee = {
      feed: {
        makeReader: () => ({
          downloadReference: async () => ({
            reference: { toHex: () => 'cd'.repeat(32) },
            feedIndex: FeedIndex.fromBigInt(4n),
            feedIndexNext: FeedIndex.fromBigInt(5n),
          }),
        }),
      },
    }
    const entry = await readLatestEntry(bee, { topic: 't', owner: '0x' + 'ab'.repeat(20) })
    assert.equal(entry.status, 'found')
    assert.equal(entry.feedIndex, '4')
    assert.equal(entry.feedIndexNext, '5')
  })

  it('readLatestEntry re-throws genuine Bee errors (no masking)', async () => {
    const bee = { feed: { makeReader: () => ({ downloadReference: async () => { throw new Error('connection refused') } }) } }
    await assert.rejects(() => readLatestEntry(bee, { topic: 't', owner: '0x' + 'ab'.repeat(20) }), /connection refused/)
  })
})

describe('next index is network-derived (offline doubles)', () => {
  it('resolveNextIndex returns the network feedIndexNext', async () => {
    let calls = 0
    const reader = {
      downloadReference: async () => {
        calls += 1
        return { feedIndexNext: FeedIndex.fromBigInt(7n) }
      },
    }
    const next = await resolveNextIndex(reader)
    assert.equal(next.toBigInt(), 7n)
    assert.equal(calls, 1)
  })
})

describe('feed write has no local counter (offline doubles)', () => {
  const identity = loadFeedIdentity()

  it('appendReference calls uploadReference with NO index option (SDK resolves from network)', async () => {
    let seenArgs
    const bee = {
      feed: {
        makeWriter: () => ({
          uploadReference: async (...args) => {
            seenArgs = args
            return { reference: { toHex: () => 'ee'.repeat(32) } }
          },
        }),
      },
    }
    await appendReference(bee, {
      topic: identity.topic,
      privateKey: '0x' + '11'.repeat(32),
      postageBatchId: 'ab'.repeat(32),
      reference: 'cd'.repeat(32),
    })
    assert.equal(seenArgs.length, 2)
    assert.equal(seenArgs[0], 'ab'.repeat(32))
    assert.equal(seenArgs[1], 'cd'.repeat(32))
  })

  it('appendReference validates inputs instead of writing garbage', async () => {
    const bee = { feed: { makeWriter: () => ({ uploadReference: async () => ({}) }) } }
    await assert.rejects(
      () => appendReference(bee, { topic: identity.topic, privateKey: '', postageBatchId: 'ab'.repeat(32), reference: 'cd'.repeat(32) }),
      /private key/i,
    )
    await assert.rejects(
      () => appendReference(bee, { topic: identity.topic, privateKey: '0x01', postageBatchId: 'xyz', reference: 'cd'.repeat(32) }),
      /postageBatchId/,
    )
  })
})

describe('live feed network (gated — BLOCKED without Bee)', () => {
  it('BLOCKED unless Bee answers: reads latest feed entry', async (t) => {
    const { beeApiUrl } = loadConfig()
    const bee = createBeeClient(beeApiUrl)
    try {
      await bee.status.getHealth()
    } catch {
      t.skip(`BLOCKED: Bee unreachable at ${beeApiUrl} — feed read needs a live node with the dev feed published.`)
      return
    }
    const entry = await readLatestEntry(bee, loadFeedIdentity())
    t.assert.ok(entry.status === 'found' || entry.status === 'empty', 'expected found|empty from live feed')
  })

  it('BLOCKED unless Bee answers: appends with network-derived index', async (t) => {
    const { beeApiUrl, feedPrivateKey, postageBatchId } = loadConfig()
    const bee = createBeeClient(beeApiUrl)
    try {
      await bee.status.getHealth()
    } catch {
      t.skip(`BLOCKED: Bee unreachable at ${beeApiUrl} — feed write needs a live node + key + postage.`)
      return
    }
    if (!feedPrivateKey || !postageBatchId) {
      t.skip('BLOCKED: FEED_PRIVATE_KEY/POSTAGE_BATCH_ID unset — refusing to invent credentials.')
      return
    }
    t.skip('BLOCKED: live append intentionally not auto-run in tests — use `node src/cli.js feed:append <ref>` explicitly.')
  })
})
