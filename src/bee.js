// Single Bee client factory (bee-js v13 API). No network calls happen here —
// the client only stores the endpoint until a namespaced method is invoked.
import { Bee } from '@ethersphere/bee-js'
import { isValidHttpUrl } from './config.js'

export function createBeeClient(beeApiUrl) {
  if (!isValidHttpUrl(beeApiUrl)) {
    throw new Error(`Invalid Bee API URL: ${JSON.stringify(beeApiUrl)}`)
  }
  // Bee constructor throws on invalid URL; let it propagate — never mask it.
  return new Bee(beeApiUrl)
}
