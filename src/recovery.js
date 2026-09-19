// Independent stranger recovery (Phase 4) — read-only, no secrets.
//
// Public recovery chain (network data + published identifiers ONLY):
//
//   owner + topic
//         ↓  reader.downloadReference() — latest feed update, no index arg
//   archive (manifest) reference
//         ↓  bee.data.download(archiveReference)
//   manifest JSON — parsed + validated by src/archive.js
//         ↓  bee.data.download(item.reference) per item
//   every folio's bytes
//
// Stranger-safety rules enforced here:
//   - No private key in any signature; FEED_PRIVATE_KEY is never loaded.
//   - No postage batch: reads are free, no stamp is ever supplied.
//   - No feed index is computed, cached, or stored — the SDK resolves the
//     latest update from the network per call.
//   - No local state: no feed.json, no .env, no localStorage, no upload
//     cache, no archive directory is consulted. Inputs are owner + topic.
//   - Reconstructed output paths are confined to the output directory
//     (absolute paths, `..` escapes, and overwrites are rejected).
//
// Exact bee-js 13.1.0 read APIs used:
//   - bee.feed.makeReader(topic, owner) (via src/feed.js makeReader)
//   - reader.downloadReference()        (latest update; empty feed throws)
//   - bee.data.download(reference)      (manifest bytes + folio bytes)
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { isAbsolute, normalize, resolve, sep } from 'node:path'
import { isValidSwarmReference, parseArchiveManifest } from './archive.js'
import { makeReader } from './feed.js'

const OWNER_PATTERN = /^(0x)?[0-9a-fA-F]{40}$/

function assertOwner(owner) {
  if (typeof owner !== 'string' || !OWNER_PATTERN.test(owner.trim())) {
    throw new Error(
      `Recovery owner must be a 20-byte hex address (got ${JSON.stringify(owner)}).`,
    )
  }
  return owner.trim()
}

function assertTopic(topic) {
  if (typeof topic !== 'string' || topic.length === 0) {
    throw new Error('Recovery topic must be a non-empty string.')
  }
  return topic
}

/**
 * Parse a stranger-supplied recovery identifier into { owner, topic }.
 * Accepted forms (all equivalent — owner + topic semantics, never a URL):
 *   - { owner, topic } object (pass-through, validated)
 *   - "owner topic" / "owner/topic" strings
 *   - JSON string '{"owner":"…","topic":"…"}'
 * Anything else throws. No private key is accepted in any form.
 */
export function parseRecoveryIdentifier(input) {
  if (typeof input === 'object' && input !== null) {
    if ('privateKey' in input || 'feedPrivateKey' in input || 'FEED_PRIVATE_KEY' in input) {
      throw new Error('Recovery identifiers never include a private key — owner + topic only.')
    }
    return { owner: assertOwner(input.owner), topic: assertTopic(input.topic) }
  }
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('Recovery identifier must be an { owner, topic } object or an "owner topic" string.')
  }
  const text = input.trim()
  if (text.startsWith('{')) {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('Recovery identifier is not valid JSON.')
    }
    return parseRecoveryIdentifier(parsed)
  }
  const parts = text.includes('/') ? text.split('/') : text.split(/\s+/)
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('Recovery identifier string must have the form "<owner> <topic>" or "<owner>/<topic>".')
  }
  return { owner: assertOwner(parts[0]), topic: assertTopic(parts[1]) }
}

function isFeedNotFoundError(error) {
  const message = String(error?.message ?? error ?? '').toLowerCase()
  const status = error?.status ?? error?.statusCode
  return status === 404 || message.includes('not found') || message.includes('no feed update')
}

// bee.data.download resolves to a Bytes instance (live) while offline
// doubles may return Buffer/Uint8Array/string — normalize without guessing.
function toUint8Array(data) {
  if (typeof data?.toUint8Array === 'function') return data.toUint8Array()
  if (typeof data === 'string') return new Uint8Array(Buffer.from(data, 'utf8'))
  if (data instanceof Uint8Array) return data
  if (Array.isArray(data)) return new Uint8Array(data)
  throw new Error('Downloaded content has an unrecognized shape — refusing to guess its bytes.')
}

function toUtf8Text(data) {
  if (typeof data?.toUtf8 === 'function') return data.toUtf8()
  return Buffer.from(toUint8Array(data)).toString('utf8')
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Recover a full archive from public identifiers only.
 * Signature is deliberately key-free and postage-free: { bee, owner, topic }.
 * Resolves the latest feed entry from the network, downloads + validates
 * the manifest, then downloads + verifies EVERY folio.
 * Returns { owner, topic, archiveReference, feedIndex, manifest,
 *            items: [{ id, name, reference, size, digest, data }] }.
 * Throws stage-tagged errors (feed empty / manifest / item) — Bee errors
 * propagate as `cause`, never masked.
 */
export async function recoverArchive({ bee, owner, topic, onItem } = {}) {
  const cleanOwner = assertOwner(owner)
  const cleanTopic = assertTopic(topic)

  let latest
  try {
    latest = await makeReader(bee, cleanTopic, cleanOwner).downloadReference()
  } catch (error) {
    if (isFeedNotFoundError(error)) {
      throw new Error(
        `Feed is empty — no archive has been published yet for owner ${cleanOwner} topic ${JSON.stringify(cleanTopic)}.`,
      )
    }
    const wrapped = new Error(`Feed resolution failed for owner ${cleanOwner} topic ${JSON.stringify(cleanTopic)}: ${error?.message ?? error}`)
    wrapped.cause = error
    throw wrapped
  }

  const archiveReference = latest.reference.toHex()
  if (!isValidSwarmReference(archiveReference)) {
    throw new Error(`Feed update for topic ${JSON.stringify(cleanTopic)} holds an invalid archive reference: ${JSON.stringify(archiveReference)}`)
  }

  let manifestText
  try {
    manifestText = toUtf8Text(await bee.data.download(archiveReference))
  } catch (error) {
    const wrapped = new Error(`Manifest download failed at archive reference ${archiveReference}: ${error?.message ?? error}`)
    wrapped.cause = error
    throw wrapped
  }

  let manifest
  try {
    manifest = parseArchiveManifest(manifestText)
  } catch (error) {
    const wrapped = new Error(`Downloaded manifest at ${archiveReference} is invalid: ${error.message}`)
    wrapped.cause = error
    throw wrapped
  }

  const items = []
  const total = manifest.items.length
  for (let index = 0; index < total; index += 1) {
    const entry = manifest.items[index]
    if (typeof onItem === 'function') {
      onItem({ index, total, id: entry.id, name: entry.name, reference: entry.reference })
    }
    let data
    try {
      data = toUint8Array(await bee.data.download(entry.reference))
    } catch (error) {
      const wrapped = new Error(
        `Folio download failed for item ${JSON.stringify(entry.id)} (${JSON.stringify(entry.name)}) at ${entry.reference}: ${error?.message ?? error}`,
      )
      wrapped.cause = error
      wrapped.partial = { archiveReference, recoveredItems: items.map((item) => item.id) }
      throw wrapped
    }
    if (entry.size !== undefined && data.byteLength !== entry.size) {
      throw new Error(
        `Recovered size mismatch for item ${JSON.stringify(entry.id)}: manifest says ${entry.size} bytes, downloaded ${data.byteLength} bytes.`,
      )
    }
    items.push({
      id: entry.id,
      name: entry.name,
      reference: entry.reference,
      size: data.byteLength,
      digest: sha256Hex(data),
      data,
    })
  }

  return {
    owner: cleanOwner,
    topic: cleanTopic,
    archiveReference,
    feedIndex: latest.feedIndex.toBigInt().toString(),
    manifest,
    items,
  }
}

/**
 * Confine a manifest item name inside the output directory.
 * Rejects absolute paths, `..` segments, and anything resolving outside
 * the output root. Returns the absolute target path.
 */
export function safeOutputPath(outputDir, name) {
  if (typeof outputDir !== 'string' || outputDir.trim() === '') {
    throw new Error('Output directory must be a non-empty string.')
  }
  if (typeof name !== 'string' || name.trim() === '' || name.trim() !== name) {
    throw new Error(`Refusing unsafe folio name: ${JSON.stringify(name)}`)
  }
  if (isAbsolute(name)) {
    throw new Error(`Refusing absolute folio path: ${JSON.stringify(name)}`)
  }
  const normalized = normalize(name)
  if (normalized === '..' || normalized.startsWith(`..${sep}`) || normalized.includes(`${sep}..${sep}`)) {
    throw new Error(`Refusing path-traversal folio name: ${JSON.stringify(name)}`)
  }
  const root = resolve(outputDir)
  const target = resolve(root, normalized)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Refusing folio path escaping the output directory: ${JSON.stringify(name)}`)
  }
  if (target === root) {
    throw new Error(`Refusing folio path resolving to the output directory itself: ${JSON.stringify(name)}`)
  }
  return target
}

/**
 * Recover an archive and reconstruct it as files in outputDir — built from
 * network data only. Existing files are never silently overwritten
 * (pass { overwrite: true } to opt in explicitly).
 * Returns { ..., outputDir, files: [absolutePaths], recoveredCount }.
 */
export async function recoverArchiveToDirectory({ bee, owner, topic, outputDir, overwrite = false, onItem } = {}) {
  if (typeof outputDir !== 'string' || outputDir.trim() === '') {
    throw new Error('Output directory must be a non-empty string.')
  }
  const result = await recoverArchive({ bee, owner, topic, onItem })
  mkdirSync(outputDir, { recursive: true })
  const files = []
  for (const item of result.items) {
    const target = safeOutputPath(outputDir, item.name)
    if (!overwrite && existsSync(target)) {
      throw new Error(`Refusing to overwrite existing file: ${target} (re-run with overwrite explicitly enabled).`)
    }
    writeFileSync(target, item.data)
    files.push(target)
  }
  return { ...result, outputDir: resolve(outputDir), files, recoveredCount: result.items.length }
}

export function formatRecoverySummary({ reference, feedIndex, entry }) {
  if (!reference || feedIndex === undefined || !entry) {
    throw new Error('Recovery summary requires reference, feedIndex and entry.')
  }
  return `feed index ${feedIndex} → ${reference} :: ${entry.title}`
}
