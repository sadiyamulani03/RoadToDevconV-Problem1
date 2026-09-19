// Feed helpers — bee-js v13 namespaced API only (bee.feed.*).
// No v12 flat methods (makeFeedWriter / createFeedManifest / upload / download).
// No fake addresses: every function requires explicit topic/owner/key inputs and
// performs no network I/O except the read/write paths, which need a live Bee
// node and honestly propagate Bee errors.
//
// NEXT-INDEX SAFETY (verified against installed @ethersphere/bee-js@13.1.0,
// dist/mjs/feed/index.js): updateFeedWithReference computes
//   const nextIndex = options?.index ?? (await findNextIndex(...))
// where findNextIndex fetches the latest update over the network and returns
// feedIndexNext (or index 0 on BeeResponseError = empty feed). THEREFORE the
// safe append is writer.uploadReference(batchId, ref) with NO index option —
// the SDK resolves the next network index internally per call. Passing an
// explicit index bypasses that lookup and MUST NOT be used for appends.
// This module never caches an index, never increments one, and never stores
// one outside the single read-then-write call.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Topic, PrivateKey, EthAddress, FeedIndex } from '@ethersphere/bee-js'

export function makeTopic(topic) {
  if (typeof topic !== 'string' || topic.length === 0) {
    throw new Error('Feed topic must be a non-empty string.')
  }
  return Topic.fromString(topic)
}

export function makeOwner(address) {
  if (typeof address !== 'string' || address.trim() === '') {
    throw new Error('Feed owner must be a non-empty hex address string.')
  }
  return new EthAddress(address.trim())
}

export function makePrivateKey(hexKey) {
  if (typeof hexKey !== 'string' || hexKey.trim() === '') {
    throw new Error('Private key must be a non-empty hex string.')
  }
  return new PrivateKey(hexKey.trim())
}

export function makeReader(bee, topic, owner) {
  return bee.feed.makeReader(makeTopic(topic), makeOwner(owner))
}

export function makeWriter(bee, topic, privateKey) {
  return bee.feed.makeWriter(makeTopic(topic), makePrivateKey(privateKey))
}

export function zeroIndex() {
  return FeedIndex.fromBigInt(0n)
}

/**
 * Resolve the next sequential feed index for an append-only feed.
 * Returns feedIndexNext from the latest update, or index 0 when the feed
 * has no updates yet (Bee reports not-found). Any other Bee error is
 * re-thrown — never masked with a fabricated index.
 */
export async function resolveNextIndex(reader) {
  try {
    const latest = await reader.downloadReference()
    return latest.feedIndexNext
  } catch (error) {
    if (isFeedNotFoundError(error)) {
      return zeroIndex()
    }
    throw error
  }
}

function isFeedNotFoundError(error) {
  const message = String(error?.message ?? error ?? '').toLowerCase()
  const status = error?.status ?? error?.statusCode
  return status === 404 || message.includes('not found') || message.includes('no feed update')
}

/**
 * Fetch the latest feed reference update (no payload fallback, no guessing).
 * Throws the underlying Bee error when the feed is missing or Bee is down.
 */
export async function fetchLatestReference(reader, options) {
  return reader.downloadReference(options)
}

const DEFAULT_IDENTITY_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'feed.json')

function isValidOwnerAddress(value) {
  return typeof value === 'string' && /^(0x)?[0-9a-fA-F]{40}$/.test(value.trim())
}

/**
 * Load the PUBLIC feed identity from the tracked feed.json.
 * Contains topic + owner only — never a private key. Throws a descriptive
 * error when the file is missing or malformed (no silent defaults).
 */
export function loadFeedIdentity(identityPath = DEFAULT_IDENTITY_PATH) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(identityPath, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot load feed identity from ${identityPath}: ${error.message}`)
  }
  if (typeof parsed?.topic !== 'string' || parsed.topic.length === 0) {
    throw new Error(`Feed identity at ${identityPath} has no valid topic.`)
  }
  if (!isValidOwnerAddress(parsed?.owner)) {
    throw new Error(`Feed identity at ${identityPath} has no valid 20-byte owner address.`)
  }
  return { topic: parsed.topic, owner: parsed.owner }
}

/**
 * Read the latest feed entry. Returns a useful result instead of crashing:
 *   { status: 'found', reference, feedIndex, feedIndexNext } — update exists
 *   { status: 'empty' } — feed has no updates yet (first publication pending)
 * Any other Bee error (node down, etc.) is re-thrown unchanged.
 */
export async function readLatestEntry(bee, { topic, owner }) {
  const reader = makeReader(bee, topic, owner)
  try {
    const latest = await reader.downloadReference()
    return {
      status: 'found',
      reference: latest.reference.toHex(),
      feedIndex: latest.feedIndex.toBigInt().toString(),
      feedIndexNext: latest.feedIndexNext.toBigInt().toString(),
    }
  } catch (error) {
    if (isFeedNotFoundError(error)) {
      return { status: 'empty' }
    }
    throw error
  }
}

function assertHex64(name, value) {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value.trim())) {
    throw new Error(`${name} must be a 64-char hex string.`)
  }
}

/**
 * SAFE APPEND — the only supported feed write.
 * Calls writer.uploadReference(postageBatchId, reference) with NO index
 * option, so the installed SDK performs its internal network lookup
 * (findNextIndex) immediately before the write. No local counter, no
 * increment, no stored index anywhere in this codebase.
 */
export async function appendReference(bee, { topic, privateKey, postageBatchId, reference }) {
  if (typeof topic !== 'string' || topic.length === 0) {
    throw new Error('Feed topic must be a non-empty string.')
  }
  if (typeof privateKey !== 'string' || privateKey.trim() === '') {
    throw new Error('Publisher private key is required for feed writes (provide FEED_PRIVATE_KEY).')
  }
  assertHex64('postageBatchId', postageBatchId)
  assertHex64('reference', reference)
  const writer = makeWriter(bee, topic, privateKey)
  // NOTE: no third argument — passing { index } would bypass the SDK's
  // network-derived next-index lookup (see header comment).
  return writer.uploadReference(postageBatchId.trim(), reference.trim())
}
