// Archive publication workflow (Phase 3).
//
// Architecture (the feed NEVER carries archive bytes):
//
//   archive files
//        ↓  bee.data.upload(batchId, bytes) per file
//   per-file Swarm references
//        ↓  buildArchiveManifest({ items }) — pure, offline, deterministic
//   manifest JSON
//        ↓  bee.data.upload(batchId, manifestJson)
//   archive (manifest) reference
//        ↓  appendReference(...) — Phase 2 safe feed append,
//             writer.uploadReference with NO index option so the SDK
//             derives the next index from the network per call
//   feed update pointing at the archive reference
//
// Exact bee-js 13.1.0 APIs used:
//   - bee.data.upload(postageBatchId, data) -> UploadResult { reference }
//   - bee.data.download(reference)          (recovery path, Phase 4)
//   - bee.stamp.getAll()                    (postage discovery)
//   - bee.feed.makeWriter/makeReader + writer.uploadReference /
//     reader.downloadReference              (via src/feed.js, unchanged)
//
// Multi-chunk: Swarm chunks payloads > ~4 KiB automatically. Both the
// per-file uploads and the manifest upload go through bee.data.upload, so
// arbitrarily large archives chunk transparently; the feed always receives
// only the 32-byte manifest reference regardless of archive size.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { buildArchiveManifest } from './archive.js'
import { appendReference, readLatestEntry } from './feed.js'
import { selectUsableBatch, findBatchById } from './postage.js'

export const NO_POSTAGE_MESSAGE =
  'No usable postage batch is available.\nFund a Bee postage batch before publishing.'

function batchIdToString(batch) {
  return String(batch?.batchID?.toString?.() ?? batch?.batchID ?? '').toLowerCase()
}

/**
 * Read an archive input path into ordered file entries.
 * Accepts a single file or a directory of files (top-level regular files
 * only, sorted by name for determinism). Throws a descriptive error for
 * missing paths, empty directories, and zero-byte files — an archive with
 * nothing to preserve is rejected before any network call.
 */
export function collectArchiveEntries(archivePath) {
  if (typeof archivePath !== 'string' || archivePath.trim() === '') {
    throw new Error('Archive path must be a non-empty string.')
  }
  const path = archivePath.trim()
  let stat
  try {
    stat = statSync(path)
  } catch {
    throw new Error(`Archive path does not exist: ${path}`)
  }
  if (stat.isFile()) {
    return [readEntry(path, basename(path))]
  }
  if (stat.isDirectory()) {
    const names = readdirSync(path).filter((name) => {
      try {
        return statSync(join(path, name)).isFile()
      } catch {
        return false
      }
    })
    names.sort()
    if (names.length === 0) {
      throw new Error(`Archive directory contains no files: ${path}`)
    }
    return names.map((name) => readEntry(join(path, name), name))
  }
  throw new Error(`Archive path is neither a file nor a directory: ${path}`)
}

function readEntry(fullPath, name) {
  const data = readFileSync(fullPath)
  if (data.byteLength === 0) {
    throw new Error(`Archive file is empty (nothing to preserve): ${fullPath}`)
  }
  return { id: name, name, data: new Uint8Array(data) }
}

/**
 * Resolve a usable postage batch id against the LIVE node.
 * - When postageBatchId is configured, it must exist on the node, be
 *   usable, and have remaining space — otherwise throw (never silently
 *   fall back to another batch, never invent one).
 * - When unconfigured, auto-select the first usable batch with space.
 * - When the node reports no usable batch, throw NO_POSTAGE_MESSAGE.
 * Bee errors (node down, etc.) propagate unchanged.
 */
export async function resolvePublishBatchId(bee, postageBatchId) {
  const batches = await bee.stamp.getAll()
  const configured = typeof postageBatchId === 'string' ? postageBatchId.trim() : ''
  if (configured !== '') {
    const match = findBatchById(batches, configured)
    if (!match) {
      throw new Error(
        `Configured postage batch ${configured} was not found on this Bee node.\nFund a Bee postage batch before publishing.`,
      )
    }
    if (match.usable !== true) {
      throw new Error(
        `Postage batch ${configured} is not usable (usable=${match.usable}).\nFund a Bee postage batch before publishing.`,
      )
    }
    return configured.toLowerCase()
  }
  const usable = selectUsableBatch(batches)
  if (!usable) {
    throw new Error(NO_POSTAGE_MESSAGE)
  }
  const id = batchIdToString(usable)
  if (!/^[0-9a-f]{64}$/.test(id)) {
    throw new Error(`${NO_POSTAGE_MESSAGE}\n(Node reported a batch with an unexpected id format.)`)
  }
  return id
}

/**
 * Upload archive entries then the manifest, all via bee.data.upload.
 * Returns { items, manifestText, archiveReference }.
 * On failure, the thrown error carries `partial` describing what DID land
 * on Swarm, so operators can distinguish "nothing uploaded" from
 * "content is live but the manifest/feed step still needs a retry".
 */
export async function uploadArchiveContent({ bee, batchId, entries, manifestName, updatedAt }) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Cannot upload an archive with no entries.')
  }
  const items = []
  for (const entry of entries) {
    let result
    try {
      result = await bee.data.upload(batchId, entry.data)
    } catch (error) {
      const partial = new Error(
        `Archive upload failed at item ${JSON.stringify(entry.name)} ` +
          `(${items.length} of ${entries.length} items uploaded): ${error?.message ?? error}`,
      )
      partial.cause = error
      partial.partial = { uploadedItems: items.map((item) => ({ ...item })) }
      throw partial
    }
    items.push({
      id: entry.id,
      name: entry.name,
      size: entry.data.byteLength,
      reference: result.reference.toHex(),
    })
  }
  const manifestText = buildArchiveManifest({ name: manifestName, items, updatedAt })
  let manifestResult
  try {
    manifestResult = await bee.data.upload(batchId, manifestText)
  } catch (error) {
    const partial = new Error(
      `Archive manifest upload failed after ${items.length} item(s) were stored: ${error?.message ?? error}. ` +
        'Item references are preserved in this error\'s `partial` field; re-run to retry the manifest upload.',
    )
    partial.cause = error
    partial.partial = { uploadedItems: items.map((item) => ({ ...item })) }
    throw partial
  }
  return {
    items,
    manifestText,
    archiveReference: manifestResult.reference.toHex(),
  }
}

/**
 * Full publication: validate input -> postage -> upload content + manifest
 * -> safe feed append (network-derived index, Phase 2 mechanism).
 * Returns public identifiers for display. `owner` is optional; when given,
 * the latest feed entry is read back to report the feed index (a failed
 * read-back does NOT fail the publication — the write already succeeded).
 */
export async function publishArchive({
  bee,
  archivePath,
  postageBatchId,
  topic,
  owner,
  privateKey,
  manifestName,
  updatedAt,
}) {
  if (typeof topic !== 'string' || topic.length === 0) {
    throw new Error('Feed topic must be a non-empty string.')
  }
  const entries = collectArchiveEntries(archivePath)
  const batchId = await resolvePublishBatchId(bee, postageBatchId)
  const { items, manifestText, archiveReference } = await uploadArchiveContent({
    bee,
    batchId,
    entries,
    manifestName,
    updatedAt,
  })
  let feedResult
  try {
    feedResult = await appendReference(bee, {
      topic,
      privateKey,
      postageBatchId: batchId,
      reference: archiveReference,
    })
  } catch (error) {
    const partial = new Error(
      `Archive content is stored at ${archiveReference} but the feed update failed: ${error?.message ?? error}. ` +
        'Re-run the publish/update command to point the feed at the existing archive reference.',
    )
    partial.cause = error
    partial.partial = { archiveReference, items: items.map((item) => ({ ...item })) }
    throw partial
  }
  let feedIndex
  let feedIndexNext
  if (typeof owner === 'string' && owner.length > 0) {
    try {
      const latest = await readLatestEntry(bee, { topic, owner })
      if (latest.status === 'found') {
        feedIndex = latest.feedIndex
        feedIndexNext = latest.feedIndexNext
      }
    } catch {
      // Read-back is best-effort reporting only; the publish succeeded.
    }
  }
  return {
    archiveReference,
    manifestText,
    itemCount: items.length,
    items,
    batchId,
    topic,
    owner,
    feedUpdateReference: feedResult?.reference?.toHex?.() ?? undefined,
    feedIndex,
    feedIndexNext,
  }
}

/**
 * Update workflow: upload the new archive/manifest separately, then append
 * the new reference through the same safe Phase 2 mechanism. Feeds are
 * append-only, so "update" is a fresh publication — there is deliberately
 * no new local counter and no locally computed latestIndex + 1 anywhere.
 */
export async function updateArchive(args) {
  return publishArchive(args)
}
