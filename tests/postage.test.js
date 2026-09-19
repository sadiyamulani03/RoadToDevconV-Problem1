// Postage status tests — deterministic offline doubles run for real.
// Anything needing a live Bee node SKIPS as BLOCKED, never fake-PASS.
// Lifetime semantics verified against installed bee-js 13.1.0:
// batch.duration.toSeconds() == node batchTTL, unit is SECONDS (not blocks).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  remainingBytes,
  selectUsableBatch,
  findBatchById,
  formatBatchSummary,
  remainingLifetimeSeconds,
  formatLifetime,
  describeBatch,
  getPostageStatus,
} from '../src/postage.js'
import { resolvePublishBatchId, NO_POSTAGE_MESSAGE } from '../src/publish.js'
import { loadConfig } from '../src/config.js'
import { createBeeClient } from '../src/bee.js'

const BATCH_A = 'aa'.repeat(32)
const BATCH_B = 'bb'.repeat(32)

// Faithful PostageBatch double: BatchId-like, boolean usable, Duration-like,
// Size-like, usage fraction + text, depth params, block number, amount.
function batchDouble(overrides = {}) {
  return {
    batchID: { toString: () => BATCH_A },
    usable: true,
    utilization: 100,
    usage: 0.25,
    usageText: '25%',
    depth: 20,
    bucketDepth: 16,
    blockNumber: 123456,
    amount: '1000000',
    label: 'test',
    immutableFlag: false,
    duration: { toSeconds: () => 86400 },
    size: { toBytes: () => 100000 },
    remainingSize: { toBytes: () => 75000 },
    ...overrides,
  }
}

function statusBee(batches, { url = 'http://localhost:1633', failWith } = {}) {
  const calls = { uploads: 0 }
  return {
    calls,
    url,
    stamp: {
      getAll: async () => {
        if (failWith) throw failWith
        return batches
      },
    },
    data: {
      upload: async () => {
        calls.uploads += 1
        throw new Error('upload must not be reached without postage')
      },
    },
  }
}

describe('postage status states (offline doubles)', () => {
  it('reports NO_POSTAGE when the node holds zero batches', async () => {
    const status = await getPostageStatus({ bee: statusBee([]) })
    assert.equal(status.state, 'NO_POSTAGE')
    assert.equal(status.batchCount, 0)
    assert.equal(status.usable, undefined)
    assert.deepEqual(status.batches, [])
  })

  it('reports USABLE with batchId, lifetime, and utilization for one usable batch', async () => {
    const status = await getPostageStatus({ bee: statusBee([batchDouble()]) })
    assert.equal(status.state, 'USABLE')
    assert.equal(status.batchCount, 1)
    assert.equal(status.usable.batchId, BATCH_A)
    assert.equal(status.usable.usable, true)
    assert.equal(status.usable.lifetimeSeconds, 86400)
    assert.match(status.usable.lifetimeHuman, /86400s/)
    assert.equal(status.usable.usageText, '25%')
    assert.equal(status.usable.usage, 0.25)
  })

  it('reports NO_USABLE_POSTAGE when batches exist but none is usable', async () => {
    const status = await getPostageStatus({
      bee: statusBee([batchDouble({ usable: false }), batchDouble({ usable: false, batchID: { toString: () => BATCH_B } })]),
    })
    assert.equal(status.state, 'NO_USABLE_POSTAGE')
    assert.equal(status.batchCount, 2)
    assert.equal(status.usable, undefined)
  })

  it('selects the first usable batch with space among many', async () => {
    const full = batchDouble({ batchID: { toString: () => BATCH_A }, remainingSize: { toBytes: () => 0 } })
    const good = batchDouble({ batchID: { toString: () => BATCH_B } })
    const status = await getPostageStatus({ bee: statusBee([full, good]) })
    assert.equal(status.state, 'USABLE')
    assert.equal(status.usable.batchId, BATCH_B)
  })

  it('throws BLOCKED (not NO_POSTAGE) when Bee is unreachable', async () => {
    const bee = statusBee([], { failWith: new Error('connection refused') })
    await assert.rejects(() => getPostageStatus({ bee }), /BLOCKED — Bee unreachable/)
    await assert.rejects(() => getPostageStatus({ bee }), /connection refused/)
  })

  it('throws on a malformed (non-array) postage response', async () => {
    const bee = { url: 'http://x', stamp: { getAll: async () => ({ batches: [] }) } }
    await assert.rejects(() => getPostageStatus({ bee }), /Malformed postage response/)
  })

  it('throws on a malformed batch entry instead of guessing', async () => {
    const noId = batchDouble({ batchID: undefined })
    await assert.rejects(() => getPostageStatus({ bee: statusBee([noId]) }), /Malformed postage batch/)
    const badUsable = batchDouble({ usable: 'yes' })
    await assert.rejects(() => getPostageStatus({ bee: statusBee([badUsable]) }), /usable must be a boolean/)
    await assert.rejects(() => getPostageStatus({ bee: statusBee([null]) }), /expected an object/)
  })

  it('requires a real Bee client', async () => {
    await assert.rejects(() => getPostageStatus({ bee: undefined }), /requires a Bee client/)
  })
})

describe('configured batch validation against the live list (offline doubles)', () => {
  it('accepts a configured batch the node confirms as usable', async () => {
    const bee = statusBee([batchDouble()])
    assert.equal(await resolvePublishBatchId(bee, BATCH_A), BATCH_A)
    const status = await getPostageStatus({ bee, postageBatchId: BATCH_A })
    assert.deepEqual(status.configured, { batchId: BATCH_A, found: true, usable: true, hasSpace: true })
  })

  it('rejects a configured batch the node does not list (no silent fallback)', async () => {
    const bee = statusBee([batchDouble()])
    await assert.rejects(() => resolvePublishBatchId(bee, BATCH_B), /was not found on this Bee node/)
    const status = await getPostageStatus({ bee, postageBatchId: BATCH_B })
    assert.deepEqual(status.configured, { batchId: BATCH_B, found: false, usable: false, hasSpace: false })
  })

  it('rejects a configured batch the node reports as unusable', async () => {
    const bee = statusBee([batchDouble({ usable: false })])
    await assert.rejects(() => resolvePublishBatchId(bee, BATCH_A), /is not usable/)
  })

  it('reports configured-but-unusable while another batch is usable (no silent switch for publish)', async () => {
    const bee = statusBee([
      batchDouble({ batchID: { toString: () => BATCH_A }, usable: false }),
      batchDouble({ batchID: { toString: () => BATCH_B } }),
    ])
    // Publish with the bad configured batch still refuses — explicit, not magic.
    await assert.rejects(() => resolvePublishBatchId(bee, BATCH_A), /is not usable/)
    const status = await getPostageStatus({ bee, postageBatchId: BATCH_A })
    assert.equal(status.state, 'USABLE')
    assert.equal(status.configured.usable, false)
  })
})

describe('lifetime calculation and units (offline)', () => {
  it('derives seconds from batch.duration.toSeconds() (node batchTTL)', () => {
    assert.equal(remainingLifetimeSeconds(batchDouble({ duration: { toSeconds: () => 3600 } })), 3600)
    assert.equal(remainingLifetimeSeconds(batchDouble({ duration: { toSeconds: () => 0 } })), 0)
  })

  it('returns NaN — never a guess — when duration is missing or broken', () => {
    assert.ok(Number.isNaN(remainingLifetimeSeconds(batchDouble({ duration: undefined }))))
    assert.ok(Number.isNaN(remainingLifetimeSeconds(batchDouble({ duration: { toSeconds: () => NaN } }))))
    assert.ok(Number.isNaN(remainingLifetimeSeconds(batchDouble({ duration: { toSeconds: () => { throw new Error('x') } } }))))
    assert.ok(Number.isNaN(remainingLifetimeSeconds(undefined)))
  })

  it('labels seconds as seconds with an honest day estimate', () => {
    assert.match(formatLifetime(86400), /^86400s \(~.*day.*estimated from node seconds\)$/)
    assert.match(formatLifetime(60), /^60s \(~under a day/)
    assert.equal(formatLifetime(0), '0s (expired)')
    assert.match(formatLifetime(NaN), /unknown/)
    assert.match(formatLifetime(-5), /unknown/)
  })

  it('describeBatch degrades lifetime to unknown instead of inventing it', () => {
    const described = describeBatch(batchDouble({ duration: undefined }))
    assert.ok(Number.isNaN(described.lifetimeSeconds))
    assert.match(described.lifetimeHuman, /unknown/)
    // Identity and usability still strict.
    assert.equal(described.batchId, BATCH_A)
  })
})

describe('utilization handling (offline)', () => {
  it('passes through node usage values, tolerates absence', () => {
    const full = describeBatch(batchDouble({ usage: 1, usageText: '100%' }))
    assert.equal(full.usage, 1)
    assert.equal(full.usageText, '100%')
    const bare = describeBatch(batchDouble({ usage: undefined, usageText: undefined, utilization: undefined }))
    assert.ok(Number.isNaN(bare.usage))
    assert.equal(bare.usageText, 'unknown')
  })

  it('legacy selectors still behave (pure, offline)', () => {
    assert.equal(remainingBytes(batchDouble()), 75000)
    assert.ok(Number.isNaN(remainingBytes({})))
    assert.equal(selectUsableBatch([batchDouble()]).usable, true)
    assert.equal(selectUsableBatch([]), undefined)
    assert.equal(findBatchById([batchDouble()], BATCH_A.toUpperCase()).usable, true)
    assert.match(formatBatchSummary(batchDouble()), /usable=true/)
  })
})

describe('publication blocked without confirmed postage (offline doubles)', () => {
  it('performs ZERO uploads when no usable batch exists', async () => {
    const bee = statusBee([])
    await assert.rejects(() => resolvePublishBatchId(bee, undefined), /No usable postage batch/)
    assert.match(NO_POSTAGE_MESSAGE, /Fund a Bee postage batch/)
    assert.equal(bee.calls.uploads, 0)
  })

  it('propagates Bee-down as BLOCKED before any upload', async () => {
    const bee = statusBee([], { failWith: new Error('connection refused') })
    await assert.rejects(() => resolvePublishBatchId(bee, undefined), /BLOCKED — Bee unreachable/)
    assert.equal(bee.calls.uploads, 0)
  })

  it('proceeds only when Bee confirms a usable batch', async () => {
    const bee = statusBee([batchDouble()])
    assert.equal(await resolvePublishBatchId(bee, undefined), BATCH_A)
  })
})

describe('no invented postage anywhere in tracked sources (offline)', () => {
  it('contains zero fake batch ids, lifetimes, or fallback batches', () => {
    for (const file of ['../src/postage.js', '../src/publish.js', '../src/cli.js']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      for (const forbidden of ['0000000000000000', 'demo-batch', 'test-batch', 'fake-batch', 'fallbackBatch', 'FALLBACK_BATCH']) {
        assert.ok(!source.toLowerCase().includes(forbidden.toLowerCase()), `${file} must not contain ${forbidden}`)
      }
    }
  })
})

describe('live postage (gated — BLOCKED without Bee)', () => {
  it('BLOCKED unless Bee answers: reads real batches and lifetimes', async (t) => {
    if (process.env.TSERING_LIVE_POSTAGE !== '1') {
      const { beeApiUrl } = loadConfig()
      const probe = createBeeClient(beeApiUrl)
      try {
        await probe.status.getHealth()
      } catch {
        t.skip(`BLOCKED — Bee unreachable at ${beeApiUrl}`)
        return
      }
      t.skip('BLOCKED — live postage read needs TSERING_LIVE_POSTAGE=1 (re-run to verify for real)')
      return
    }
    const { beeApiUrl, postageBatchId } = loadConfig()
    const bee = createBeeClient(beeApiUrl)
    let status
    try {
      status = await getPostageStatus({ bee, postageBatchId })
    } catch (error) {
      if (String(error?.message ?? '').startsWith('BLOCKED — Bee unreachable')) {
        t.skip(`BLOCKED — Bee unreachable at ${beeApiUrl}`)
        return
      }
      throw error
    }
    if (status.state === 'NO_POSTAGE') {
      t.skip('BLOCKED — no postage batches')
      return
    }
    // PASS requires actual node data: real ids, real usability, real seconds.
    t.assert.ok(status.batchCount >= 1, 'expected at least one real batch')
    for (const entry of status.batches) {
      t.assert.match(entry.batchId, /^[0-9a-f]{64}$/)
      t.assert.equal(typeof entry.usable, 'boolean')
      t.assert.ok(Number.isFinite(entry.lifetimeSeconds) || Number.isNaN(entry.lifetimeSeconds))
    }
    const usable = status.batches.filter((entry) => entry.usable)
    t.diagnostic(
      `Live postage at ${beeApiUrl}: ${status.batchCount} batch(es), ` +
        `${usable.length} usable, state=${status.state}` +
        (status.usable ? `, best=${status.usable.batchId} lifetime=${status.usable.lifetimeHuman}` : ''),
    )
  })
})
