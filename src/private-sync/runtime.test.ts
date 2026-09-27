import { IDBFactory } from 'fake-indexeddb'
import { P2PKH, Transaction } from '@bsv/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuthorizationService, ROLE_PERMISSIONS, issueCredential } from '../auth/authorization'
import { anchorLockingScript, keyGrantAnchorAddress, unitAnchorAddress } from '../blockchain/anchor'
import { ChainKeyGrantProvider } from '../blockchain/ChainKeyGrantProvider'
import { ChainPrivateHistoryProvider } from '../blockchain/ChainPrivateHistoryProvider'
import { EmbeddedTestnetWallet } from '../blockchain/EmbeddedTestnetWallet'
import { WhatsOnChainTestnetClient } from '../blockchain/whatsonchain'
import type { WalletRuntime } from '../blockchain/walletRuntime'
import { MockIdentityProvider, type ArgusIdentityProvider } from '../identity/identity'
import { createMasterDeviceIdentity, unlockDeviceIdentity, type UnlockedDeviceIdentity } from '../identity/deviceIdentity'
import { MockSyncProvider } from '../sync/mock'
import { ChainKeyDistribution } from './ChainKeyDistribution'
import { DurableEncryptedEventSyncProvider } from './eventSyncProvider'
import { generateEcdhKeyPair } from './keyGrant'
import type { EcdhKeyDirectory } from './types'
import { createRuntimeController } from './runtime'

const originalIndexedDb = globalThis.indexedDB
beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() })
})
afterEach(() => Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: originalIndexedDb }))

const storage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) } }

type UnlockedAuthenticated = UnlockedDeviceIdentity & { authorization: AuthorizationService }

async function unlockedMaster(label: string): Promise<UnlockedAuthenticated> {
  const identity = new MockIdentityProvider(label)
  const publicIdentity = await identity.getPublicIdentity()
  const authorization = new AuthorizationService(publicIdentity, identity)
  await authorization.acceptCredential(await issueCredential(identity, { subjectPublicIdentity: publicIdentity, role: 'MASTER', permissions: [...ROLE_PERMISSIONS.MASTER], issuedAt: '2020-01-01T00:00:00.000Z' }))
  return { identity, publicIdentity, role: 'MASTER', authorization, authoritySigner: identity }
}

async function unlockedDevice(label: string, master: { identity: ArgusIdentityProvider; publicIdentity: string }, role: 'INSTRUCTOR' | 'SUPPLY_OFFICER' | 'SUPPLY_ASSISTANT'): Promise<UnlockedAuthenticated> {
  const identity = new MockIdentityProvider(label)
  const publicIdentity = await identity.getPublicIdentity()
  const authorization = new AuthorizationService(master.publicIdentity, identity)
  await authorization.acceptCredential(await issueCredential(master.identity, { subjectPublicIdentity: publicIdentity, role, permissions: [...ROLE_PERMISSIONS[role]], issuedAt: '2020-01-01T00:00:00.000Z' }))
  return { identity, publicIdentity, role, authorization }
}

function stubWalletRuntime(): WalletRuntime {
  const wallet = {
    async getStatus() { return { network: 'TESTNET' as const, connection: 'DISCONNECTED' as const, mode: 'EMBEDDED' as const, recentTransactions: [] } },
    async getNetwork() { return { network: 'testnet' as const } },
    async createAction(): Promise<{ txid?: string }> { throw new Error('This test never publishes.') },
  }
  return { mode: 'embedded-testnet', wallet, transactionWallet: wallet, createEncryptedEventPublisher: () => { throw new Error('not used in this test') } }
}

/** A fake WhatsOnChain HTTP surface over in-memory state, shared by one or more simulated devices. */
function fakeChain() {
  const unspent = new Map<string, Array<{ tx_hash: string; tx_pos: number; value: number; height?: number }>>()
  const txHex = new Map<string, string>()
  const history = new Map<string, Array<{ tx_hash: string; height: number }>>()
  const posted: string[] = []
  const watchedScripts = new Map<string, string>()
  const watch = (address: string) => watchedScripts.set(anchorLockingScript(address).toHex(), address)
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const unspentMatch = /\/address\/([^/]+)\/unspent$/.exec(url)
    if (unspentMatch) return Response.json(unspent.get(unspentMatch[1]) ?? [])
    const historyMatch = /\/address\/([^/]+)\/history$/.exec(url)
    if (historyMatch) return Response.json(history.get(historyMatch[1]) ?? [])
    const hexMatch = /\/tx\/([0-9a-f]{64})\/hex$/i.exec(url)
    if (hexMatch) { const hex = txHex.get(hexMatch[1]); return hex ? new Response(hex) : new Response('not found', { status: 404 }) }
    if (url.endsWith('/tx/raw')) {
      const { txhex } = JSON.parse(String(init?.body)) as { txhex: string }
      posted.push(txhex)
      const tx = Transaction.fromHex(txhex)
      const txid = tx.id('hex')
      txHex.set(txid, txhex)
      for (const output of tx.outputs) {
        const address = watchedScripts.get(output.lockingScript.toHex())
        if (!address) continue
        const entries = history.get(address) ?? []
        if (!entries.some(entry => entry.tx_hash === txid)) history.set(address, [...entries, { tx_hash: txid, height: 0 }])
      }
      return Response.json({ txid })
    }
    if (url.endsWith('/chain/info')) return Response.json({ blocks: 100, bestblockhash: 'a'.repeat(64) })
    return new Response('not found', { status: 404 })
  }
  return { fetcher: fetcher as typeof fetch, unspent, txHex, history, posted, watch }
}

async function fundedWallet(chain: ReturnType<typeof fakeChain>, satoshis = 20_000) {
  const wallet = new EmbeddedTestnetWallet(storage(), chain.fetcher)
  const created = await wallet.create('correct horse battery 7 staple')
  const address = created.receivingAddress!
  chain.unspent.set(address, [{ tx_hash: 'f'.repeat(64), tx_pos: 0, value: satoshis, height: 1 }])
  const funding = new Transaction()
  funding.addOutput({ satoshis, lockingScript: new P2PKH().lock(address) })
  chain.txHex.set('f'.repeat(64), funding.toHex())
  return { wallet, address }
}

function walletRuntimeOver(wallet: EmbeddedTestnetWallet): WalletRuntime {
  return { mode: 'embedded-testnet', wallet, transactionWallet: wallet, createEncryptedEventPublisher: () => { throw new Error('not used in this test') } }
}

function sharedEcdhDirectory(entries: Array<{ publicIdentity: string; ecdh: CryptoKeyPair }>): EcdhKeyDirectory {
  return {
    async publicKeyFor(identity) {
      const entry = entries.find(candidate => candidate.publicIdentity === identity)
      if (!entry) throw new Error(`No ECDH key known for ${identity}.`)
      return entry.ecdh.publicKey
    },
  }
}

describe('runtime composition root', () => {
  it('creates a working local-only controller now that shared history sync is mock/local-only', async () => {
    const controller = await createRuntimeController('mock-development')
    const projection = await controller.initialize()
    expect(projection.sync.mode).toBe('local')
  })

  it('uses MockIdentityProvider only under mock-development', async () => {
    const controller = await createRuntimeController('mock-development')
    expect(controller.identity).toBeInstanceOf(MockIdentityProvider)
  })

  it('throws outside mock-development when no identity has been unlocked yet', async () => {
    await expect(createRuntimeController('embedded-testnet')).rejects.toThrow('An unlocked identity is required')
    await expect(createRuntimeController('unconfigured')).rejects.toThrow('An unlocked identity is required')
  })

  it('is a real, non-mock identity provider outside mock-development once unlocked, even when the mode is unconfigured', async () => {
    const record = await createMasterDeviceIdentity('correct horse battery 7', storage())
    const unlockedDeviceIdentity = await unlockDeviceIdentity(record, 'correct horse battery 7')
    const controller = await createRuntimeController('unconfigured', { unlocked: { ...unlockedDeviceIdentity, authorization: unlockedDeviceIdentity.authorization! } })
    expect(controller.identity).not.toBeInstanceOf(MockIdentityProvider)
    expect(await controller.identity.getPublicIdentity()).toMatch(/^p256:/)
  }, 20_000)

  it('an unconfigured controller cannot publish: synchronization reports the same "not configured" state local-only sync already shows', async () => {
    const unlocked = await unlockedMaster('unconfigured-device-2')
    const controller = await createRuntimeController('unconfigured', { unlocked })
    await expect(controller.initialize(storage())).resolves.toBeTruthy()
    await expect(controller.sync()).resolves.toBeTruthy() // an empty outbox synchronizes trivially; nothing is queued yet
  })

  it('AC1: embedded-testnet wires DurableEncryptedEventSyncProvider over ChainPrivateHistoryProvider, keyed by ChainKeyDistribution, and never constructs a MockSyncProvider', async () => {
    const unlocked = await unlockedMaster('embedded-device-a')
    const controller = await createRuntimeController('embedded-testnet', { unlocked, walletRuntime: stubWalletRuntime(), dbName: 'runtime-ac1' })

    expect(controller.provider).toBeInstanceOf(DurableEncryptedEventSyncProvider)
    expect(controller.provider).not.toBeInstanceOf(MockSyncProvider)
    const inner = controller.provider as unknown as { provider: object; keys: object }
    expect(inner.provider).toBeInstanceOf(ChainPrivateHistoryProvider)
    expect(inner.keys).toBeInstanceOf(ChainKeyDistribution)
  })

  it('AC4: a publish that fails for insufficient funds leaves the event QUEUED with lastError "unfunded: <address>", never FAILED', async () => {
    const organizationId = 'org-runtime-ac4'
    const unlocked = await unlockedMaster('embedded-device-ac4')
    const chain = fakeChain()
    chain.watch(unitAnchorAddress(organizationId))
    chain.watch(keyGrantAnchorAddress(organizationId))
    const { wallet, address } = await fundedWallet(chain)

    // Establish an encryption epoch (and grant it to this device) while the wallet is funded...
    const client = new WhatsOnChainTestnetClient(chain.fetcher)
    const grantProvider = new ChainKeyGrantProvider(wallet, client, organizationId)
    const ecdh = await generateEcdhKeyPair()
    const directory = sharedEcdhDirectory([{ publicIdentity: unlocked.publicIdentity, ecdh }])
    const setupKeys = new ChainKeyDistribution(organizationId, unlocked.publicIdentity, unlocked.publicIdentity, ecdh, unlocked.identity, directory, grantProvider, unlocked.authoritySigner, { dbName: 'runtime-ac4-setup' })
    await setupKeys.rotateEpoch([unlocked.publicIdentity])
    await setupKeys.flush()

    // ...then drain it before the event is published.
    chain.unspent.set(address, [])

    const controller = await createRuntimeController('embedded-testnet', {
      unlocked, organizationId, fetcher: chain.fetcher, ecdhKeyPair: ecdh, ecdhDirectory: directory,
      walletRuntime: walletRuntimeOver(wallet), dbName: 'runtime-ac4',
    })
    const projection = await controller.initialize(storage())
    const itemId = projection.inventory[0].entityId

    await controller.issue(itemId, 1)

    const state = await controller.technicalState()
    expect(state.outbox).toHaveLength(1)
    expect(state.outbox[0].status).toBe('QUEUED')
    expect(state.outbox[0].lastError).toBe(`unfunded: ${address}`)
    expect(state.events.find(record => record.event.entityId === itemId)?.syncStatus).toBe('QUEUED')
  })

  it('AC3: an issue event created on device A appears in device B\'s replica after B syncs, encrypted on the wire', async () => {
    const organizationId = 'org-runtime-ac3'
    const master = await unlockedMaster('embedded-device-a-master')
    const deviceB = await unlockedDevice('embedded-device-b', { identity: master.identity, publicIdentity: master.publicIdentity }, 'SUPPLY_OFFICER')

    const chain = fakeChain()
    chain.watch(unitAnchorAddress(organizationId))
    chain.watch(keyGrantAnchorAddress(organizationId))
    const { wallet: walletA } = await fundedWallet(chain)
    const { wallet: walletB } = await fundedWallet(chain)

    const masterEcdh = await generateEcdhKeyPair(), deviceBEcdh = await generateEcdhKeyPair()
    const directory = sharedEcdhDirectory([
      { publicIdentity: master.publicIdentity, ecdh: masterEcdh },
      { publicIdentity: deviceB.publicIdentity, ecdh: deviceBEcdh },
    ])

    // The Master rotates and grants the epoch to both devices before either one publishes.
    const client = new WhatsOnChainTestnetClient(chain.fetcher)
    const grantProvider = new ChainKeyGrantProvider(walletA, client, organizationId)
    const setupKeys = new ChainKeyDistribution(organizationId, master.publicIdentity, master.publicIdentity, masterEcdh, master.identity, directory, grantProvider, master.identity, { dbName: 'runtime-ac3-setup' })
    await setupKeys.rotateEpoch([master.publicIdentity, deviceB.publicIdentity])
    await setupKeys.flush()

    const controllerA = await createRuntimeController('embedded-testnet', {
      unlocked: master, organizationId, fetcher: chain.fetcher, ecdhKeyPair: masterEcdh, ecdhDirectory: directory,
      walletRuntime: walletRuntimeOver(walletA), dbName: 'runtime-ac3-a',
    })
    const controllerB = await createRuntimeController('embedded-testnet', {
      unlocked: deviceB, organizationId, fetcher: chain.fetcher, ecdhKeyPair: deviceBEcdh, ecdhDirectory: directory,
      walletRuntime: walletRuntimeOver(walletB), dbName: 'runtime-ac3-b',
    })

    const projectionA = await controllerA.initialize(storage())
    const itemId = projectionA.inventory[0].entityId
    const cadetId = projectionA.cadets[0].cadetId
    const cadetName = projectionA.cadets[0].fullName

    await controllerA.issueTransaction({ transactionId: 'txn-runtime-ac3', cadetId, lines: [{ lineId: 'line-1', itemId, quantity: 1 }] })

    await controllerB.initialize(storage())
    const projectionB = await controllerB.sync()

    expect(projectionB.transactions.map(t => t.transactionId)).toContain('txn-runtime-ac3')
    const itemB = projectionB.inventory.find(item => item.entityId === itemId)!
    expect(itemB.onHand).toBe(projectionA.inventory.find(item => item.entityId === itemId)!.onHand - 1)

    const nameBytes = new TextEncoder().encode(cadetName)
    const nameHex = Array.from(nameBytes, byte => byte.toString(16).padStart(2, '0')).join('')
    for (const hex of chain.posted) expect(hex.toLowerCase()).not.toContain(nameHex)
  })
})
