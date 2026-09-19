// Live-Bee integration probe — SKIPPED unless a Bee node answers.
// Never fakes publishing, feeds, or postage. Run with: npm test.
// Gate: BEE_API_URL (default http://localhost:1633).
import { describe, it } from 'node:test'
import { loadConfig } from '../src/config.js'
import { createBeeClient } from '../src/bee.js'

async function beeReachable(bee) {
  try {
    await bee.status.getHealth()
    return true
  } catch {
    return false
  }
}

describe('live Bee integration (gated)', () => {
  it('reads node health when Bee is up, otherwise skips', async (t) => {
    const { beeApiUrl } = loadConfig()
    const bee = createBeeClient(beeApiUrl)
    if (!(await beeReachable(bee))) {
      t.skip(`Bee unreachable at ${beeApiUrl} — start a Bee node for real integration.`)
      return
    }
    const health = await bee.status.getHealth()
    t.assert.ok(health?.status, 'expected a health status from live Bee')
  })
})
