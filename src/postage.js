// Postage helpers — pure selection/formatting over REAL bee.stamp.getAll()
// results. Never fabricates batch ids, utilization, or durations. Live reads
// happen in scripts/check-batch.js; this module only interprets them.

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
