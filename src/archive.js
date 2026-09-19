// Archive payload helpers — pure, offline, deterministic.
// Phase 1 scope: build/parse/validate ONLY. No network publishing here;
// network publish (bee.file.upload + feed.uploadReference + manifest) lands
// in Phase 2 against a live Bee node with real postage.

export const ARCHIVE_PAYLOAD_VERSION = 1

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
