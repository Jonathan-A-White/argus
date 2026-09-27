import type { AuthorizationService } from '../auth/authorization'
import { ChainKeyGrantProvider } from '../blockchain/ChainKeyGrantProvider'
import { ChainPrivateHistoryProvider, type ChainPrivateHistoryWallet } from '../blockchain/ChainPrivateHistoryProvider'
import { resolveBlockchainMode, type BlockchainMode } from '../blockchain/config'
import { createWalletRuntime, type WalletRuntime } from '../blockchain/walletRuntime'
import { WhatsOnChainTestnetClient } from '../blockchain/whatsonchain'
import { DistributedAppController } from '../distributed/appIntegration'
import type { UnlockedDeviceIdentity } from '../identity/deviceIdentity'
import { IndexedDbRepository } from '../storage/repository'
import type { EventSyncProvider } from '../sync/mock'
import { ChainKeyDistribution } from './ChainKeyDistribution'
import { DurableEncryptedEventSyncProvider } from './eventSyncProvider'
import { generateEcdhKeyPair } from './keyGrant'
import type { EcdhKeyDirectory } from './types'

export const ARGUS_ORGANIZATION_ID = 'argus-organization'

export type UnlockedIdentity = UnlockedDeviceIdentity & { authorization: AuthorizationService }

export type RuntimeControllerDependencies = {
  /** Required outside mock-development: the real, unlocked device identity and its accepted authority credential. */
  unlocked?: UnlockedIdentity
  organizationId?: string
  storage?: Storage
  fetcher?: typeof fetch
  /** Shares one wallet/client instance with the wallet status UI when supplied; otherwise a fresh one is composed. */
  walletRuntime?: WalletRuntime
  /** This device's key-agreement keypair. Regenerated per session when not supplied: cross-reload ECDH persistence is not yet wired. */
  ecdhKeyPair?: CryptoKeyPair
  /** Resolves another admitted device's ECDH public key. Defaults to a directory that only knows this device's own key: real cross-device discovery is not yet wired. */
  ecdhDirectory?: EcdhKeyDirectory
  dbName?: string
}

/** A sync provider for blockchain modes that have not been configured: every operation fails with the same message the settings panel already shows for local-only sync. */
class NotConfiguredSyncProvider implements EventSyncProvider {
  async publish(): Promise<never> { throw new Error('Local repository checked; shared synchronization is not configured on this device.') }
  async pull() { return [] }
}

function selfOnlyEcdhDirectory(localIdentity: string, localEcdh: CryptoKeyPair): EcdhKeyDirectory {
  return {
    async publicKeyFor(identity: string) {
      if (identity === localIdentity) return localEcdh.publicKey
      throw new Error(`No ECDH directory entry for ${identity}; cross-device key discovery is not yet wired.`)
    },
  }
}

function buildChainWallet(walletRuntime: WalletRuntime): ChainPrivateHistoryWallet {
  const transactionWallet = walletRuntime.transactionWallet
  if (!transactionWallet) throw new Error('Configure an embedded-testnet or external-brc100-testnet wallet before publishing audit history.')
  return {
    getStatus: () => walletRuntime.wallet.getStatus(),
    async createAction(args) {
      const result = await transactionWallet.createAction({
        description: 'A.R.G.U.S. encrypted history',
        outputs: args.outputs.map(output => ({ ...output, outputDescription: 'A.R.G.U.S. data output', tags: ['argus'] })),
        labels: ['argus-encrypted-history'],
        options: { acceptDelayedBroadcast: false, returnTXIDOnly: false, randomizeOutputs: false },
      })
      return { txid: result.txid }
    },
  }
}

/**
 * Composition root for the normal application runtime. embedded-testnet and external-brc100-testnet wire the
 * real stack: the unlocked device identity, DurableEncryptedEventSyncProvider over a ChainPrivateHistoryProvider
 * (the embedded/external wallet plus WhatsOnChain), and ChainKeyDistribution reading its epoch grants from the
 * chain. mock-development keeps the local-only mock stack. unconfigured returns a controller whose synchronization
 * always reports the same "not configured" state the settings panel already shows for local-only sync.
 */
export async function createRuntimeController(
  mode: BlockchainMode = resolveBlockchainMode(import.meta.env.VITE_ARGUS_BLOCKCHAIN_MODE),
  dependencies: RuntimeControllerDependencies = {},
): Promise<DistributedAppController> {
  if (mode === 'mock-development') return new DistributedAppController()

  const { unlocked } = dependencies
  if (!unlocked) throw new Error('An unlocked identity is required outside mock-development mode.')
  const organizationId = dependencies.organizationId ?? ARGUS_ORGANIZATION_ID
  const repository = new IndexedDbRepository(dependencies.dbName)

  if (mode === 'unconfigured') {
    return new DistributedAppController(repository, {
      identity: unlocked.identity,
      authorization: unlocked.authorization,
      provider: new NotConfiguredSyncProvider(),
      organizationId,
    })
  }

  const walletRuntime = dependencies.walletRuntime ?? createWalletRuntime(mode, { storage: dependencies.storage, fetcher: dependencies.fetcher })
  const chainWallet = buildChainWallet(walletRuntime)
  const client = new WhatsOnChainTestnetClient(dependencies.fetcher)
  const historyProvider = new ChainPrivateHistoryProvider(chainWallet, client, organizationId, { dbName: dependencies.dbName })
  const grantProvider = new ChainKeyGrantProvider(chainWallet, client, organizationId)

  const localIdentity = unlocked.publicIdentity
  const localEcdh = dependencies.ecdhKeyPair ?? await generateEcdhKeyPair()
  const directory = dependencies.ecdhDirectory ?? selfOnlyEcdhDirectory(localIdentity, localEcdh)
  const masterPublicIdentity = unlocked.authorization.rootIdentity
  const keys = new ChainKeyDistribution(organizationId, masterPublicIdentity, localIdentity, localEcdh, unlocked.identity, directory, grantProvider, unlocked.authoritySigner, { dbName: dependencies.dbName })
  // currentEpoch() reads only what sync() has already discovered; without this, a freshly composed
  // device would report "No encryption epoch exists" even when a grant is already on chain for it.
  await keys.sync().catch(() => undefined)

  const provider = new DurableEncryptedEventSyncProvider('chain', repository, historyProvider, unlocked.identity, keys, organizationId)
  return new DistributedAppController(repository, { identity: unlocked.identity, authorization: unlocked.authorization, provider, organizationId })
}
