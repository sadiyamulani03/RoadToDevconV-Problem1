// Archive payload + manifest helpers — pure, offline, deterministic.
// - buildArchivePayload/parseArchivePayload: Phase 1 single-entry payload
//   (kept for backward compatibility; not used by the manifest flow).
// - Manifest layer (Phase 3): versioned `tsering-archive` manifest that lists
//   per-file Swarm references. The manifest JSON itself is uploaded to Swarm
//   via bee.data.upload and the resulting reference — never the manifest
//   bytes — is what the feed stores (see src/publish.js).
//
// Manifest structure (documented, versioned, deterministic):
//   {
//     "schema": "tsering-archive",
//     "version": 1,
//     "name": "Tsering Manuscript Archive",
//     "updatedAt": "<ISO-8601 timestamp>",
//     "items": [
//       { "id": "folio-0001", "name": "folio-0001.jpg",
//         "size": 1234, "reference": "<64-hex swarm ref>" }
//     ]
//   }
// Recovery (Phase 4) needs only: owner + topic -> feed -> archive reference
// -> manifest bytes -> per-item references. No local publisher state.

export const ARCHIVE_PAYLOAD_VERSION = 1

export const ARCHIVE_SCHEMA = 'tsering-archive'
export const ARCHIVE_MANIFEST_VERSION = 1
export const ARCHIVE_MANIFEST_NAME = 'Tsering Manuscript Archive'

export function buildArchivePayload({ title, body, createdAt } = {}) {
  if (typeof title !== 'string' || title.trim() === '') {
    throw new Error('Archive entry title must be a non-empty string.')
  }
  if (typeof body !== 'string' || body.trim() === '') {
    throw new Error('Archive entry body must be a non-empty string.')
  }
  const timestamp = createdAt ?? new Date().toISOString()
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`Invalid createdAt timestamp: ${JSON.stringify(createdAt)}`)
  }
  return JSON.stringify(
    {
      version: ARCHIVE_PAYLOAD_VERSION,
      title: title.trim(),
      body,
      createdAt: timestamp,
    },
    null,
    2,
  )
}

export function parseArchivePayload(raw) {
  const text = typeof raw === 'string' ? raw : raw?.toString?.() ?? ''
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Archive payload is not valid JSON.')
  }
  if (parsed?.version !== ARCHIVE_PAYLOAD_VERSION) {
    throw new Error(`Unsupported archive payload version: ${JSON.stringify(parsed?.version)}`)
  }
  if (typeof parsed.title !== 'string' || typeof parsed.body !== 'string') {
    throw new Error('Archive payload missing required title/body fields.')
  }
  return parsed
}

/**
 * A Swarm reference is the 32-byte content hash bee.data.upload /
 * bee.file.upload returns, hex-encoded (64 chars). Encrypted uploads
 * produce 64-byte (128 hex char) references; both are accepted here so
 * manifests stay forward-compatible, but the feed write path
 * (src/feed.js appendReference) stays strict 64-hex.
 */
export function isValidSwarmReference(value) {
  return (
    typeof value === 'string' && /^([0-9a-fA-F]{64}|[0-9a-fA-F]{128})$/.test(value.trim())
  )
}

function assertManifestItem(item, index) {
  if (typeof item !== 'object' || item === null) {
    throw new Error(`Archive manifest item at index ${index} must be an object.`)
  }
  if (typeof item.id !== 'string' || item.id.trim() === '') {
    throw new Error(`Archive manifest item at index ${index} must have a non-empty string id.`)
  }
  if (typeof item.name !== 'string' || item.name.trim() === '') {
    throw new Error(`Archive manifest item at index ${index} must have a non-empty string name.`)
  }
  if (!isValidSwarmReference(item.reference)) {
    throw new Error(
      `Archive manifest item ${JSON.stringify(item.id)} has an invalid Swarm reference: ${JSON.stringify(item.reference)}`,
    )
  }
  if (item.size !== undefined && (!Number.isInteger(item.size) || item.size < 0)) {
    throw new Error(`Archive manifest item ${JSON.stringify(item.id)} has an invalid size: ${JSON.stringify(item.size)}`)
  }
}

function canonicalManifestObject({ name, items, updatedAt }) {
  // Fixed key order + items sorted by id => deterministic serialization:
  // identical logical input always yields byte-identical JSON.
  const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return {
    schema: ARCHIVE_SCHEMA,
    version: ARCHIVE_MANIFEST_VERSION,
    name,
    updatedAt,
    items: sorted.map((item) => {
      const entry = { id: item.id, name: item.name, reference: item.reference }
      if (item.size !== undefined) entry.size = item.size
      return entry
    }),
  }
}

/**
 * Build a versioned archive manifest JSON string from validated items.
 * Throws on invalid input — never fabricates references or timestamps
 * beyond defaulting `updatedAt` to now and `name` to the archive name.
 */
export function buildArchiveManifest({ name, items, updatedAt } = {}) {
  const manifestName =
    name === undefined ? ARCHIVE_MANIFEST_NAME : name
  if (typeof manifestName !== 'string' || manifestName.trim() === '') {
    throw new Error('Archive manifest name must be a non-empty string.')
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Archive manifest requires a non-empty items array.')
  }
  const timestamp = updatedAt ?? new Date().toISOString()
  if (typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`Invalid updatedAt timestamp: ${JSON.stringify(updatedAt)}`)
  }
  items.forEach(assertManifestItem)
  const seen = new Set()
  for (const item of items) {
    if (seen.has(item.id)) {
      throw new Error(`Archive manifest contains a duplicate item id: ${JSON.stringify(item.id)}`)
    }
    seen.add(item.id)
  }
  return JSON.stringify(
    canonicalManifestObject({ name: manifestName.trim(), items, updatedAt: timestamp }),
    null,
    2,
  )
}

/**
 * Parse and validate an archive manifest. Returns the parsed manifest
 * object. Rejects malformed JSON, wrong schema, unsupported versions,
 * missing fields, bad references, and duplicate ids.
 */
export function parseArchiveManifest(raw) {
  const text = typeof raw === 'string' ? raw : raw?.toString?.() ?? ''
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Archive manifest is not valid JSON.')
  }
  if (parsed?.schema !== ARCHIVE_SCHEMA) {
    throw new Error(`Unsupported archive manifest schema: ${JSON.stringify(parsed?.schema)}`)
  }
  if (parsed?.version !== ARCHIVE_MANIFEST_VERSION) {
    throw new Error(`Unsupported archive manifest version: ${JSON.stringify(parsed?.version)}`)
  }
  if (typeof parsed?.name !== 'string' || parsed.name.trim() === '') {
    throw new Error('Archive manifest is missing a valid name.')
  }
  if (typeof parsed?.updatedAt !== 'string' || Number.isNaN(Date.parse(parsed.updatedAt))) {
    throw new Error('Archive manifest is missing a valid updatedAt timestamp.')
  }
  if (!Array.isArray(parsed?.items) || parsed.items.length === 0) {
    throw new Error('Archive manifest must contain a non-empty items array.')
  }
  parsed.items.forEach(assertManifestItem)
  const seen = new Set()
  for (const item of parsed.items) {
    if (seen.has(item.id)) {
      throw new Error(`Archive manifest contains a duplicate item id: ${JSON.stringify(item.id)}`)
    }
    seen.add(item.id)
  }
  return parsed
}
