import { resolveBlockchainMode, type BlockchainMode } from '../blockchain/config'
import { DistributedAppController } from '../distributed/appIntegration'
import { IndexedDbRepository } from '../storage/repository'
import { MockSyncProvider } from '../sync/mock'
import type { AuthorizationService } from '../auth/authorization'
import type { UnlockedDeviceIdentity } from './deviceIdentity'

export const ARGUS_ORGANIZATION_ID = 'argus-organization'

export type AdmittedIdentity = UnlockedDeviceIdentity & { authorization: AuthorizationService }

export function identityGateRequired(mode: BlockchainMode = resolveBlockchainMode(import.meta.env.VITE_ARGUS_BLOCKCHAIN_MODE)) {
  return mode !== 'mock-development'
}

export function buildAuthenticatedController(unlocked: AdmittedIdentity) {
  return new DistributedAppController(new IndexedDbRepository(), {
    identity: unlocked.identity,
    authorization: unlocked.authorization,
    provider: new MockSyncProvider(),
    organizationId: ARGUS_ORGANIZATION_ID,
  })
}

/** DistributedAppController's default identity provider: the real, unlocked device identity outside mock-development, and MockIdentityProvider only under mock-development. */
export function defaultRuntimeController(mode: BlockchainMode, unlocked?: AdmittedIdentity): DistributedAppController {
  if (mode === 'mock-development') return new DistributedAppController()
  if (!unlocked) throw new Error('An unlocked identity is required outside mock-development mode.')
  return buildAuthenticatedController(unlocked)
}
