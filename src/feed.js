// Feed helpers — bee-js v13 namespaced API only (bee.feed.*).
// No v12 flat methods (makeFeedWriter / createFeedManifest / upload / download).
// No fake addresses: every function requires explicit topic/owner/key inputs and
// performs no network I/O except resolveNextIndex / fetchLatestReference, which
// need a live Bee node and honestly propagate Bee errors.
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
