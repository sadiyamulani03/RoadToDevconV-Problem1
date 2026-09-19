#!/usr/bin/env node
// Minimal CLI — dispatches to real modules only. Commands that need a live
// Bee node fail loudly with the underlying error; nothing is simulated.
import { loadConfig } from './config.js'
import { createBeeClient } from './bee.js'
import { readNodeStatus, formatStatusSummary } from './status.js'
import { selectUsableBatch, formatBatchSummary, getPostageStatus } from './postage.js'
import { loadFeedIdentity, readLatestEntry, appendReference } from './feed.js'
import { publishArchive } from './publish.js'
import { recoverArchiveToDirectory } from './recovery.js'

const USAGE = `Tsering Archive CLI (foundation)

Usage:
  node src/cli.js status            Read live Bee node status (needs Bee up)
  node src/cli.js batches           List live postage batches (needs Bee up)
  node src/cli.js config            Print resolved config (no network)
  node src/cli.js feed              Print tracked feed identity topic+owner (no network)
  node src/cli.js feed:read         Read latest feed entry (needs Bee up)
  node src/cli.js feed:append <ref> Append 64-hex Swarm ref to feed (needs Bee + key + postage)
  node src/cli.js publish <archive> Publish an archive file/dir to Swarm + feed (needs Bee + key + postage)
  node src/cli.js update <archive>  Publish a new archive version to Swarm + feed (same safe append)
  node src/cli.js recover <owner> <topic> <outdir>  Recover every folio from owner+topic (needs Bee; no key, no postage)
  node src/cli.js postage           Show node-derived postage status (needs Bee; read-only)
  node src/cli.js help              Show this help
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

  if (command === 'feed') {
    console.log(JSON.stringify(loadFeedIdentity(), null, 2))
    return
  }

  if (command === 'feed:read') {
    const { beeApiUrl } = loadConfig()
    const identity = loadFeedIdentity()
    const bee = createBeeClient(beeApiUrl)
    const entry = await readLatestEntry(bee, identity)
    if (entry.status === 'empty') {
      console.log('Feed is empty — no updates published yet. First publication will use index 0.')
      return
    }
    console.log(JSON.stringify(entry, null, 2))
    return
  }

  if (command === 'feed:append') {
    const [, reference] = process.argv.slice(2)
    if (!reference) {
      console.error('Usage: node src/cli.js feed:append <64-hex-swarm-reference>')
      process.exitCode = 1
      return
    }
    const { beeApiUrl, feedPrivateKey, postageBatchId } = loadConfig()
    const identity = loadFeedIdentity()
    const bee = createBeeClient(beeApiUrl)
    const result = await appendReference(bee, {
      topic: identity.topic,
      privateKey: feedPrivateKey,
      postageBatchId,
      reference,
    })
    console.log(`Feed appended. Update reference: ${result.reference.toHex()}`)
    return
  }

  if (command === 'publish' || command === 'update') {
    const [, archivePath] = process.argv.slice(2)
    if (!archivePath) {
      console.error(`Usage: node src/cli.js ${command} <archive-file-or-directory>`)
      process.exitCode = 1
      return
    }
    const { beeApiUrl, feedPrivateKey, postageBatchId } = loadConfig()
    if (!feedPrivateKey) {
      console.error('Error: FEED_PRIVATE_KEY is required for publishing (feed writes must be signed).')
      process.exitCode = 1
      return
    }
    const identity = loadFeedIdentity()
    const bee = createBeeClient(beeApiUrl)
    try {
      const result = await publishArchive({
        bee,
        archivePath,
        postageBatchId,
        topic: identity.topic,
        owner: identity.owner,
        privateKey: feedPrivateKey,
      })
      console.log(command === 'publish' ? 'Tsering Archive Published' : 'Tsering Archive Updated')
      console.log('')
      console.log('Feed Owner:')
      console.log(identity.owner)
      console.log('')
      console.log('Feed Topic:')
      console.log(identity.topic)
      console.log('')
      console.log('Archive Reference:')
      console.log(result.archiveReference)
      console.log('')
      console.log('Feed Index:')
      console.log(result.feedIndex ?? 'unknown (feed write succeeded; index read-back unavailable)')
      console.log('')
      console.log('Postage:')
      console.log(result.batchId)
      console.log('')
      console.log(`Items: ${result.itemCount}`)
    } catch (error) {
      console.error(`Error: ${error?.message ?? error}`)
      if (error?.partial) {
        console.error(`Partial state: ${JSON.stringify(error.partial, null, 2)}`)
      }
      process.exitCode = 1
    }
    return
  }

  if (command === 'recover') {
    const [, owner, topic, outputDir] = process.argv.slice(2)
    if (!owner || !topic || !outputDir) {
      console.error('Usage: node src/cli.js recover <owner> <topic> <output-directory>')
      console.error('Hint: run `node src/cli.js feed` to see the tracked public identity.')
      process.exitCode = 1
      return
    }
    // NOTE: recovery is stranger-safe by construction — no FEED_PRIVATE_KEY
    // and no POSTAGE_BATCH_ID are loaded here. Reads are free and unsigned.
    const { beeApiUrl } = loadConfig()
    const bee = createBeeClient(beeApiUrl)
    console.log('Tsering Archive Recovery')
    console.log('')
    console.log(`Owner: ${owner}`)
    console.log(`Topic: ${topic}`)
    console.log('')
    console.log('Resolving latest feed entry...')
    try {
      const result = await recoverArchiveToDirectory({
        bee,
        owner,
        topic,
        outputDir,
        onItem: ({ index, total, name }) => {
          if (index === 0) {
            console.log('')
            console.log('Recovering folios...')
          }
          console.log(`[${index + 1}/${total}] ${name}`)
        },
      })
      console.log('')
      console.log(`Archive reference: ${result.archiveReference}`)
      console.log('')
      console.log('Downloading manifest...')
      console.log(`Manifest version: ${result.manifest.version}`)
      console.log(`Items: ${result.items.length}`)
      console.log('')
      console.log('Recovery complete.')
      console.log(`Recovered: ${result.recoveredCount}/${result.items.length}`)
      console.log(`Output: ${result.outputDir}`)
    } catch (error) {
      console.error(`Error: ${error?.message ?? error}`)
      if (error?.partial) {
        console.error(`Partial state: ${JSON.stringify(error.partial, null, 2)}`)
      }
      process.exitCode = 1
    }
    return
  }

  if (command === 'postage') {
    // Read-only postage status: node-derived batches, lifetime, usability.
    // No key, no purchase, no top-up — this command never spends anything.
    const { beeApiUrl, postageBatchId } = loadConfig()
    const bee = createBeeClient(beeApiUrl)
    console.log('Swarm Postage Status')
    console.log('')
    try {
      const status = await getPostageStatus({ bee, postageBatchId })
      console.log(`Bee: reachable at ${status.beeUrl}`)
      console.log('')
      console.log(`Batches discovered: ${status.batchCount}`)
      if (status.state === 'NO_POSTAGE') {
        console.log('')
        console.log('No postage batches found on this Bee node.')
        console.log('')
        console.log('Publishing is blocked until a usable postage batch is available.')
        return
      }
      for (const entry of status.batches) {
        console.log('')
        console.log(`Batch: ${entry.batchId}`)
        console.log(`Usable: ${entry.usable ? 'yes' : 'no'}`)
        console.log(`Remaining lifetime: ${entry.lifetimeHuman}`)
        console.log(`Utilization: ${entry.usageText}${Number.isFinite(entry.usage) ? ` (${entry.usage})` : ''}`)
        console.log(`Depth: ${Number.isFinite(entry.depth) ? entry.depth : 'unknown'}`)
        console.log(`Remaining size: ${Number.isFinite(entry.remainingBytes) ? `${entry.remainingBytes} bytes` : 'unknown'}`)
      }
      if (status.configured) {
        console.log('')
        console.log(
          `Configured batch ${status.configured.batchId}: ` +
            (status.configured.found
              ? `found, usable=${status.configured.usable}, hasSpace=${status.configured.hasSpace}`
              : 'NOT FOUND on this Bee node — a configured value alone proves nothing.'),
        )
      }
      console.log('')
      if (status.state === 'USABLE') {
        console.log(`Usable batch available: ${status.usable.batchId}`)
      } else {
        console.log('No usable postage batch found.')
        console.log('')
        console.log('Publishing is blocked until a usable postage batch is available.')
      }
    } catch (error) {
      // A down node is NOT "no postage" — report reachability distinctly.
      console.log(`Bee: unreachable at ${beeApiUrl}`)
      console.log('')
      console.log('Cannot determine postage state.')
      console.error(`Error: ${error?.message ?? error}`)
      process.exitCode = 1
    }
    return
  }

  console.error(`Unknown command: ${command}\n${USAGE}`)
  process.exitCode = 1
}

main().catch((error) => {
  console.error(`Error: ${error?.message ?? error}`)
  process.exitCode = 1
})
