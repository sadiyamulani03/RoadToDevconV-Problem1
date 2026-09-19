// Live postage probe — lists ONLY real bee.stamp.getAll() batches.
// Reports "none usable" honestly; never invents a batch id.
import { loadConfig } from '../src/config.js'
import { createBeeClient } from '../src/bee.js'
import { selectUsableBatch, formatBatchSummary } from '../src/postage.js'

const { beeApiUrl } = loadConfig()
const bee = createBeeClient(beeApiUrl)

try {
  const batches = await bee.stamp.getAll()
  if (batches.length === 0) {
    console.log('No postage batches on this Bee node. Buy one before publishing.')
    process.exit(0)
  }
  for (const batch of batches) {
    console.log(formatBatchSummary(batch))
  }
  console.log(selectUsableBatch(batches) ? 'Usable batch available.' : 'No usable batch with remaining space.')
} catch (error) {
  console.error(`Postage check failed at ${beeApiUrl}: ${error?.message ?? error}`)
  process.exitCode = 1
}
