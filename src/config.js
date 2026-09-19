// Central configuration loader. No secrets live here — values come from the
// environment (optionally via a local .env file that is never committed).
// See .env.example for placeholders.
import 'dotenv/config'

export const DEFAULT_BEE_API_URL = 'http://localhost:1633'

function emptyToUndefined(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

export function isValidHttpUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function isValidHex64(value) {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value.trim())
}

export function loadConfig(env = process.env) {
  const beeApiUrl = emptyToUndefined(env.BEE_API_URL) ?? DEFAULT_BEE_API_URL

  if (!isValidHttpUrl(beeApiUrl)) {
    throw new Error(`Invalid BEE_API_URL: ${JSON.stringify(beeApiUrl)}. Expected http(s) URL.`)
  }

  return {
    beeApiUrl,
    feedOwner: emptyToUndefined(env.FEED_OWNER),
    feedTopic: emptyToUndefined(env.FEED_TOPIC),
    feedPrivateKey: emptyToUndefined(env.FEED_PRIVATE_KEY),
    postageBatchId: emptyToUndefined(env.POSTAGE_BATCH_ID),
  }
}
