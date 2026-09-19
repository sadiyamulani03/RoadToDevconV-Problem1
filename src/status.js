// Node status reader — aggregates ONLY live Bee responses (v13 namespaces:
// bee.status.* + bee.connectivity.*). Throws when Bee is unreachable; never
// returns canned health/peers/reserve values.
export async function readNodeStatus(bee) {
  const [health, readiness, versions, nodeInfo, chainState, reserveState, topology, peers] =
    await Promise.all([
      bee.status.getHealth(),
      bee.status.getReadiness(),
      bee.status.getVersions(),
      bee.status.getNodeInfo(),
      bee.status.getChainState(),
      bee.status.getReserveState(),
      bee.connectivity.getTopology().catch((error) => ({ error: String(error?.message ?? error) })),
      bee.connectivity.getPeers().catch((error) => ({ error: String(error?.message ?? error) })),
    ])

  return { health, readiness, versions, nodeInfo, chainState, reserveState, topology, peers }
}

export function formatStatusSummary(status) {
  const lines = []
  lines.push(`health=${status?.health?.status ?? 'unknown'}`)
  lines.push(`readiness=${status?.readiness?.status ?? 'unknown'}`)
  lines.push(`beeMode=${status?.nodeInfo?.beeMode ?? 'unknown'}`)
  lines.push(`beeVersion=${status?.versions?.beeVersion ?? 'unknown'}`)
  lines.push(`apiVersion=${status?.versions?.beeApiVersion ?? 'unknown'}`)
  const connected = status?.topology?.connected
  lines.push(`connectedPeers=${connected ?? 'unknown'}`)
  return lines.join(' | ')
}
