import { DistributedAppController } from '../distributed/appIntegration'

/** Composition root for the normal application runtime. Shared history sync is mock/local-only until the BSV testnet chain transport lands. */
export async function createRuntimeController() {
  return new DistributedAppController()
}
