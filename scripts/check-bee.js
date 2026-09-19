// Live Bee smoke probe — reads ONLY real node endpoints.
// Fails loudly when Bee is down; never prints canned values.
import { loadConfig } from '../src/config.js'
import { createBeeClient } from '../src/bee.js'
import { readNodeStatus, formatStatusSummary } from '../src/status.js'

const { beeApiUrl } = loadConfig()
const bee = createBeeClient(beeApiUrl)

try {
  const status = await readNodeStatus(bee)
  console.log(formatStatusSummary(status))
  console.log(JSON.stringify(status, null, 2))
} catch (error) {
  console.error(`Bee unreachable at ${beeApiUrl}: ${error?.message ?? error}`)
  process.exitCode = 1
}
