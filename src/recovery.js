// Recovery helpers — offline validation plus a thin live-Bee fetch.
// Phase 1 scope: no fake recovery. fetchLatestArchive() requires a live Bee
// node and real feed identity; it propagates Bee errors unchanged so callers
// can distinguish "Bee down" from "feed empty" from "reference retrieved".
import { parseArchivePayload } from './archive.js'
import { makeReader, fetchLatestReference } from './feed.js'

export async function fetchLatestArchive({ bee, topic, owner, downloadFile }) {
  const reader = makeReader(bee, topic, owner)
  const latest = await fetchLatestReference(reader)
  const reference = latest.reference.toHex()
  const file = await downloadFile(reference)
  const text = file?.data?.toUtf8 ? file.data.toUtf8() : String(file?.data ?? file ?? '')
  return {
    reference,
    feedIndex: latest.feedIndex.toBigInt().toString(),
    entry: parseArchivePayload(text),
  }
}

export function formatRecoverySummary({ reference, feedIndex, entry }) {
  if (!reference || feedIndex === undefined || !entry) {
    throw new Error('Recovery summary requires reference, feedIndex and entry.')
  }
  return `feed index ${feedIndex} → ${reference} :: ${entry.title}`
}
