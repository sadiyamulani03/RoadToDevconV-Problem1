#!/usr/bin/env node
// Minimal CLI — dispatches to real modules only. Commands that need a live
// Bee node fail loudly with the underlying error; nothing is simulated.
import { loadConfig } from './config.js'
import { createBeeClient } from './bee.js'
import { readNodeStatus, formatStatusSummary } from './status.js'
import { selectUsableBatch, formatBatchSummary } from './postage.js'

const USAGE = `Tsering Archive CLI (foundation)

Usage:
  node src/cli.js status        Read live Bee node status (needs Bee up)
  node src/cli.js batches       List live postage batches (needs Bee up)
  node src/cli.js config        Print resolved config (no network)
  node src/cli.js help          Show this help
`

async function main() {
  const [command] = process.argv.slice(2)

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE)
    return
  }

  if (command === 'config') {
    const config = loadConfig()
    console.log(
      JSON.stringify(
        { ...config, feedPrivateKey: config.feedPrivateKey ? '<set>' : undefined },
        null,
        2,
      ),
    )
    return
  }

  if (command === 'status') {
    const { beeApiUrl } = loadConfig()
    const bee = createBeeClient(beeApiUrl)
    const status = await readNodeStatus(bee)
    console.log(formatStatusSummary(status))
    console.log(JSON.stringify(status, null, 2))
    return
  }

  if (command === 'batches') {
    const { beeApiUrl } = loadConfig()
    const bee = createBeeClient(beeApiUrl)
    const batches = await bee.stamp.getAll()
    if (batches.length === 0) {
      console.log('No postage batches found on this Bee node.')
      return
    }
    for (const batch of batches) {
      console.log(formatBatchSummary(batch))
    }
    const usable = selectUsableBatch(batches)
    console.log(usable ? 'Usable batch available.' : 'No usable batch with remaining space.')
    return
  }

  console.error(`Unknown command: ${command}\n${USAGE}`)
  process.exitCode = 1
}

main().catch((error) => {
  console.error(`Error: ${error?.message ?? error}`)
  process.exitCode = 1
})
