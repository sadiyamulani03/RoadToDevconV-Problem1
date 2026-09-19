// Postage helpers — pure selection/formatting/derivation over REAL
// bee.stamp.getAll() results. Never fabricates batch ids, utilization, or
// lifetimes. Live reads happen in scripts/check-batch.js, src/publish.js
// (resolvePublishBatchId) and the `postage` CLI command; this module only
// interprets node data.
//
// VERIFIED bee-js 13.1.0 field semantics (against the installed package,
// dist/mjs/utils/stamps.js + dist/types/types/index.d.ts):
//   - getAll() returns PostageBatch[] mapped from the Bee GET /stamps
//     response by mapPostageBatch().
//   - batchID: BatchId (64-hex via .toString()/.toHex()).
//   - usable: boolean straight from the node.
//   - utilization (number), usage (0..1 float), usageText ("50%").
//   - depth, bucketDepth, blockNumber, amount, label, immutableFlag.
//   - duration: Duration built as Duration.fromSeconds(normalizeBatchTTL(
//     raw.batchTTL)) — i.e. REMAINING LIFETIME IN SECONDS, sourced from the
//     node's batchTTL field. NOT blocks. Calendar conversions (days) below
//     are arithmetic estimates from those seconds and are labeled as such.
//   - size / remainingSize / theoreticalSize: Size (.toBytes()).
//
// Units discipline: seconds are reported as seconds; "~N days" is always
// presented as an estimate derived from seconds, never as a node promise.

export function remainingBytes(batch) {
  if (typeof batch?.remainingSize?.toBytes === 'function') {
    return Number(batch.remainingSize.toBytes())
  }
  if (typeof batch?.remainingSize === 'number') return batch.remainingSize
  if (typeof batch?.remainingSize === 'bigint') return Number(batch.remainingSize)
  return NaN
}

/**
 * Select the first usable batch with remaining space.
 * Returns undefined when none match — callers must treat that as
 * "no postage available", never invent a batch id.
 */
export function selectUsableBatch(batches, minRemainingBytes = 1) {
  if (!Array.isArray(batches)) {
    throw new Error('Postage batches must be an array.')
  }
  return batches.find((batch) => batch?.usable === true && remainingBytes(batch) >= minRemainingBytes)
}

export function findBatchById(batches, batchId) {
  if (!Array.isArray(batches)) {
    throw new Error('Postage batches must be an array.')
  }
  const needle = String(batchId ?? '').toLowerCase()
  return batches.find((batch) => String(batch?.batchID?.toString?.() ?? '').toLowerCase() === needle)
}

export function formatBatchSummary(batch) {
  if (!batch) {
    throw new Error('Cannot summarize an empty batch.')
  }
  const id = batch.batchID?.toString?.() ?? String(batch.batchID ?? 'unknown')
  const usage = batch.usageText ?? String(batch.usage ?? 'unknown')
  let duration = 'unknown'
  try {
    duration = `${batch.duration?.toSeconds?.() ?? batch.duration ?? 'unknown'}s remaining`
  } catch {
    duration = 'unknown'
  }
  return `batch ${id} | usable=${batch.usable} | usage=${usage} | ${duration}`
}

/**
 * Remaining lifetime in seconds, derived ONLY from the node's batchTTL via
 * batch.duration.toSeconds(). Returns NaN when the batch carries no usable
 * duration — callers must render that as "unknown", never invent a value.
 */
export function remainingLifetimeSeconds(batch) {
  try {
    const seconds = Number(batch?.duration?.toSeconds?.())
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : NaN
  } catch {
    return NaN
  }
}

/**
 * Honest lifetime rendering: seconds first (the node unit), with a
 * clearly-labeled day estimate. Never labels blocks as days, never claims
 * a calendar expiry the node did not promise.
 */
export function formatLifetime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return 'unknown (node reported no usable duration)'
  }
  if (seconds === 0) return '0s (expired)'
  const days = seconds / 86400
  const dayText = days >= 2 ? `${days.toFixed(1)} days` : days >= 1 ? 'about 1 day' : 'under a day'
  return `${seconds}s (~${dayText}, estimated from node seconds)`
}

function batchIdToHex(batch, index) {
  const hex = String(batch?.batchID?.toString?.() ?? '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`Malformed postage batch at index ${index}: invalid batchID ${JSON.stringify(hex)}.`)
  }
  return hex
}

/**
 * Validate one raw bee.stamp.getAll() entry and normalize it to plain
 * displayable data. Throws on malformed identity/usability (load-bearing
 * fields); degrades lifetime/size to unknown-NaN honestly when absent.
 */
export function describeBatch(batch, index = 0) {
  if (typeof batch !== 'object' || batch === null) {
    throw new Error(`Malformed postage batch at index ${index}: expected an object.`)
  }
  if (typeof batch.usable !== 'boolean') {
    throw new Error(`Malformed postage batch at index ${index}: usable must be a boolean.`)
  }
  const usage = typeof batch.usage === 'number' && batch.usage >= 0 && batch.usage <= 1 ? batch.usage : NaN
  return {
    batchId: batchIdToHex(batch, index),
    usable: batch.usable,
    utilization: typeof batch.utilization === 'number' ? batch.utilization : NaN,
    usage,
    usageText: typeof batch.usageText === 'string' ? batch.usageText : 'unknown',
    depth: typeof batch.depth === 'number' ? batch.depth : NaN,
    bucketDepth: typeof batch.bucketDepth === 'number' ? batch.bucketDepth : NaN,
    blockNumber: typeof batch.blockNumber === 'number' ? batch.blockNumber : NaN,
    amount: batch.amount?.toString?.() ?? String(batch.amount ?? 'unknown'),
    label: typeof batch.label === 'string' ? batch.label : '',
    lifetimeSeconds: remainingLifetimeSeconds(batch),
    lifetimeHuman: formatLifetime(remainingLifetimeSeconds(batch)),
    remainingBytes: remainingBytes(batch),
  }
}

function beeUrlOf(bee) {
  return typeof bee?.url === 'string' && bee.url.length > 0 ? bee.url : 'unknown Bee endpoint'
}

/**
 * Node-derived postage status. Distinguishes the three honest states:
 *   - Bee unreachable  → THROWS `BLOCKED — Bee unreachable at <url>…`
 *     (a down node is NOT "no postage"; callers must not conflate them).
 *   - reachable, zero batches      → { state: 'NO_POSTAGE', … }
 *   - reachable, none usable       → { state: 'NO_USABLE_POSTAGE', … }
 *   - reachable, usable batch      → { state: 'USABLE', usable, … }
 * When postageBatchId is configured it is validated against the LIVE list:
 * reported as { found, usable, hasSpace } — a configured value alone proves
 * nothing. Malformed node responses throw instead of being guessed at.
 */
export async function getPostageStatus({ bee, postageBatchId, minRemainingBytes = 1 } = {}) {
  if (!bee || typeof bee?.stamp?.getAll !== 'function') {
    throw new Error('getPostageStatus requires a Bee client with stamp.getAll().')
  }
  const beeUrl = beeUrlOf(bee)
  let batches
  try {
    batches = await bee.stamp.getAll()
  } catch (error) {
    const blocked = new Error(`BLOCKED — Bee unreachable at ${beeUrl}: ${error?.message ?? error}`)
    blocked.cause = error
    throw blocked
  }
  if (!Array.isArray(batches)) {
    throw new Error(`Malformed postage response from ${beeUrl}: expected an array of batches.`)
  }
  const described = batches.map((batch, index) => describeBatch(batch, index))
  const usable = described.find((entry) => {
    const raw = batches[described.indexOf(entry)]
    return entry.usable === true && remainingBytes(raw) >= minRemainingBytes
  })

  let configured
  const needle = typeof postageBatchId === 'string' ? postageBatchId.trim().toLowerCase() : ''
  if (needle !== '') {
    const matchIndex = described.findIndex((entry) => entry.batchId === needle)
    if (matchIndex === -1) {
      configured = { batchId: needle, found: false, usable: false, hasSpace: false }
    } else {
      const raw = batches[matchIndex]
      configured = {
        batchId: needle,
        found: true,
        usable: described[matchIndex].usable === true,
        hasSpace: remainingBytes(raw) >= minRemainingBytes,
      }
    }
  }

  const state = described.length === 0 ? 'NO_POSTAGE' : usable ? 'USABLE' : 'NO_USABLE_POSTAGE'
  return { state, beeUrl, batchCount: described.length, batches: described, usable, configured }
}
