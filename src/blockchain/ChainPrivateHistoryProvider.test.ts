import { IDBFactory } from 'fake-indexeddb'
import { LockingScript, P2PKH, Transaction } from '@bsv/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { anchorLockingScript, unitAnchorAddress } from './anchor'
import { ChainPrivateHistoryProvider, InsufficientFundsError } from './ChainPrivateHistoryProvider'
import { decodeEventOutput, encodeEventOutput } from './EncryptedEventTestnet'
import { EmbeddedTestnetWallet } from './EmbeddedTestnetWallet'
import { WhatsOnChainTestnetClient } from './whatsonchain'
import { encryptEvent } from '../private-sync/crypto'
import { MockIdentityProvider } from '../identity/identity'
import { DurableEncryptedEventSyncProvider } from '../private-sync/eventSyncProvider'
import { PrivateSyncEngine } from '../private-sync/engine'
import { MockEpochKeyDistribution } from '../private-sync/keys'
import type { EncryptedArgusEnvelope } from '../private-sync/types'
import { MemoryRepository } from '../storage/repository'
import type { SignedArgusEvent } from '../distributed/types'

const originalIndexedDb = globalThis.indexedDB
function useFreshIndexedDb() {
  const factory = new IDBFactory()
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: factory })
  return factory
}
afterEach(() => Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: originalIndexedDb }))

const storage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) } }

async function makeEnvelope(organizationId: string, eventId: string): Promise<EncryptedArgusEnvelope> {
  const identity = new MockIdentityProvider('chain-user'), keys = new MockEpochKeyDistribution(organizationId)
  await keys.rotateEpoch([await identity.getPublicIdentity()])
  const unsigned = { protocol: 'ARGUS' as const, protocolVersion: 1 as const, organizationId, eventVersion: 1 as const, eventId, eventType: 'COUNT_CONTRIBUTED' as const, entityId: 'session-a', actorPublicIdentity: await identity.getPublicIdentity(), timestamp: '2026-09-27T00:00:00.000Z', baseVersion: 0, payload: { assignmentId: 'bin-a', itemId: 'shirt', quantity: 3 } }
  const event = { ...unsigned, signature: await identity.sign(JSON.stringify(unsigned)) } as SignedArgusEvent
  return encryptEvent(event, identity, keys)
}

/** A funding transaction paying `value` satoshis to `address`; its own hash need not match any stub tx_hash, matching EmbeddedTestnetWallet's own tests. */
function fundingTxHex(address: string, value: number): string {
  const tx = new Transaction()
  tx.addOutput({ satoshis: value, lockingScript: new P2PKH().lock(address) })
  return tx.toHex()
}

/** A transaction carrying the envelope's data output plus the anchor P2PKH output, as ChainPrivateHistoryProvider.publish would build. */
function dataTxHex(anchorAddress: string, envelope: EncryptedArgusEnvelope): string {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(encodeEventOutput(envelope)) })
  tx.addOutput({ satoshis: 1, lockingScript: anchorLockingScript(anchorAddress) })
  return tx.toHex()
}

function fakeChain() {
  const unspent = new Map<string, Array<{ tx_hash: string; tx_pos: number; value: number; height?: number }>>()
  const txHex = new Map<string, string>()
  const history = new Map<string, Array<{ tx_hash: string; height: number }>>()
  const posted: string[] = []
  /** Address -> its P2PKH locking script hex; a broadcast tx paying one of these shows up in that address's history, as WhatsOnChain would report it. */
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
  return { fetcher, unspent, txHex, history, posted, watch }
}

async function fundedWallet(chain: ReturnType<typeof fakeChain>) {
  const wallet = new EmbeddedTestnetWallet(storage(), chain.fetcher as typeof fetch)
  const created = await wallet.create('correct horse battery 7 staple')
  const address = created.receivingAddress!
  chain.unspent.set(address, [{ tx_hash: 'a'.repeat(64), tx_pos: 0, value: 10_000, height: 1 }])
  chain.txHex.set('a'.repeat(64), fundingTxHex(address, 10_000))
  return { wallet, address }
}

describe('ChainPrivateHistoryProvider', () => {
  it('AC1: publishes one transaction with the envelope and anchor outputs, and indexes the eventId', async () => {
    useFreshIndexedDb()
    const organizationId = 'org-chain-1'
    const envelope = await makeEnvelope(organizationId, 'event-1')
    const chain = fakeChain()
    const { wallet } = await fundedWallet(chain)
    const client = new WhatsOnChainTestnetClient(chain.fetcher as typeof fetch)
    const provider = new ChainPrivateHistoryProvider(wallet, client, organizationId, { dbName: 'chain-test-ac1' })

    const result = await provider.publish(envelope)
    expect(result).toMatchObject({ accepted: true, duplicate: false })
    expect(chain.posted).toHaveLength(1)

    const tx = Transaction.fromHex(chain.posted[0])
    expect(decodeEventOutput(tx.outputs[0].lockingScript.toHex())).toEqual(envelope)
    expect(tx.outputs[1].satoshis).toBe(1)
    expect(tx.outputs[1].lockingScript.toHex()).toBe(anchorLockingScript(unitAnchorAddress(organizationId)).toHex())

    expect(await provider.getByEventId('event-1')).toEqual(envelope)
  })

  it('AC2: a duplicate publish broadcasts once; a different ciphertext hash for the same eventId collides', async () => {
    useFreshIndexedDb()
    const organizationId = 'org-chain-2'
    const envelope = await makeEnvelope(organizationId, 'event-2')
    const chain = fakeChain()
    const { wallet } = await fundedWallet(chain)
    const client = new WhatsOnChainTestnetClient(chain.fetcher as typeof fetch)
    const provider = new ChainPrivateHistoryProvider(wallet, client, organizationId, { dbName: 'chain-test-ac2' })

    const first = await provider.publish(envelope)
    expect(first.duplicate).toBe(false)
    const second = await provider.publish(envelope)
    expect(second.duplicate).toBe(true)
    expect(chain.posted).toHaveLength(1)

    const altered: EncryptedArgusEnvelope = { ...envelope, ciphertextHash: `${'0'.repeat(63)}1` }
    await expect(provider.publish(altered)).rejects.toThrow(/EVENT_COLLISION/)
    expect(chain.posted).toHaveLength(1)
  })

  it('AC3: an unfunded wallet throws InsufficientFundsError carrying address and balance, and posts nothing', async () => {
    useFreshIndexedDb()
    const organizationId = 'org-chain-3'
    const envelope = await makeEnvelope(organizationId, 'event-3')
    const chain = fakeChain()
    const wallet = new EmbeddedTestnetWallet(storage(), chain.fetcher as typeof fetch)
    const created = await wallet.create('correct horse battery 7 staple')
    const client = new WhatsOnChainTestnetClient(chain.fetcher as typeof fetch)
    const provider = new ChainPrivateHistoryProvider(wallet, client, organizationId, { dbName: 'chain-test-ac3' })

    await expect(provider.publish(envelope)).rejects.toBeInstanceOf(InsufficientFundsError)
    await expect(provider.publish(envelope)).rejects.toMatchObject({ address: created.receivingAddress, balance: 0 })
    expect(chain.posted).toHaveLength(0)
  })

  it('AC4: getSince orders confirmed ascending then unconfirmed, and only returns what is new on a later call', async () => {
    useFreshIndexedDb()
    const organizationId = 'org-chain-4'
    const anchorAddress = unitAnchorAddress(organizationId)
    const chain = fakeChain()
    const wallet = new EmbeddedTestnetWallet(storage(), chain.fetcher as typeof fetch)
    await wallet.create('correct horse battery 7 staple')
    const client = new WhatsOnChainTestnetClient(chain.fetcher as typeof fetch)
    const provider = new ChainPrivateHistoryProvider(wallet, client, organizationId, { dbName: 'chain-test-ac4' })

    const envelopeA = await makeEnvelope(organizationId, 'event-a')
    const envelopeB = await makeEnvelope(organizationId, 'event-b')
    const envelopeC = await makeEnvelope(organizationId, 'event-c')
    const hexA = dataTxHex(anchorAddress, envelopeA), hexB = dataTxHex(anchorAddress, envelopeB), hexC = dataTxHex(anchorAddress, envelopeC)
    const idA = Transaction.fromHex(hexA).id('hex'), idB = Transaction.fromHex(hexB).id('hex'), idC = Transaction.fromHex(hexC).id('hex')
    chain.txHex.set(idA, hexA); chain.txHex.set(idB, hexB); chain.txHex.set(idC, hexC)
    chain.history.set(anchorAddress, [{ tx_hash: idA, height: 500 }, { tx_hash: idB, height: 200 }, { tx_hash: idC, height: 0 }])

    const page = await provider.getSince('0')
    expect(page.envelopes.map(envelope => (envelope as EncryptedArgusEnvelope).eventId)).toEqual(['event-b', 'event-a', 'event-c'])
    expect(page.hasMore).toBeFalsy()

    const again = await provider.getSince(page.cursor)
    expect(again.envelopes).toEqual([])

    const envelopeD = await makeEnvelope(organizationId, 'event-d')
    const hexD = dataTxHex(anchorAddress, envelopeD), idD = Transaction.fromHex(hexD).id('hex')
    chain.txHex.set(idD, hexD)
    chain.history.set(anchorAddress, [{ tx_hash: idA, height: 500 }, { tx_hash: idB, height: 200 }, { tx_hash: idC, height: 0 }, { tx_hash: idD, height: 600 }])

    const next = await provider.getSince(again.cursor)
    expect(next.envelopes.map(envelope => (envelope as EncryptedArgusEnvelope).eventId)).toEqual(['event-d'])
  })

  it('health() reports ok after reaching the chain tip', async () => {
    useFreshIndexedDb()
    const chain = fakeChain()
    const wallet = new EmbeddedTestnetWallet(storage(), chain.fetcher as typeof fetch)
    await wallet.create('correct horse battery 7 staple')
    const client = new WhatsOnChainTestnetClient(chain.fetcher as typeof fetch)
    const provider = new ChainPrivateHistoryProvider(wallet, client, 'org-chain-health', { dbName: 'chain-test-health' })
    expect(await provider.health()).toEqual({ ok: true, provider: 'whatsonchain-testnet', protocolVersion: 1 })
  })

  describe('AC5: the PrivateHistoryProvider contract, run against ChainPrivateHistoryProvider', () => {
    it('reuses the durable encrypted envelope after a lost publish acknowledgement', async () => {
      useFreshIndexedDb()
      const organizationId = 'org-chain-retry'
      const identity = new MockIdentityProvider('retry-user'), keys = new MockEpochKeyDistribution(organizationId)
      await keys.rotateEpoch([await identity.getPublicIdentity()])
      const repository = new MemoryRepository()
      const chain = fakeChain()
      const { wallet } = await fundedWallet(chain)
      const client = new WhatsOnChainTestnetClient(chain.fetcher as typeof fetch)
      const transport = new ChainPrivateHistoryProvider(wallet, client, organizationId, { dbName: 'chain-test-ac5-retry' })
      const originalPublish = transport.publish.bind(transport)
      let lose = true
      transport.publish = async envelope => { const acknowledgment = await originalPublish(envelope); if (lose) { lose = false; throw new Error('acknowledgement lost') } return acknowledgment }

      const provider = new DurableEncryptedEventSyncProvider('transport', repository, transport, identity, keys, organizationId)
      const unsigned = { protocol: 'ARGUS' as const, protocolVersion: 1 as const, organizationId, eventVersion: 1 as const, eventId: 'event-retry', eventType: 'COUNT_CONTRIBUTED' as const, entityId: 'session', actorPublicIdentity: await identity.getPublicIdentity(), timestamp: '2026-09-27T00:00:00.000Z', payload: { assignmentId: 'a', itemId: 'i', quantity: 3 }, signature: 'placeholder' }
      const event = unsigned as SignedArgusEvent

      // The transport durably indexed the event before "losing" its acknowledgement; the sync provider
      // reconciles that ambiguity through getByEventId and resolves rather than throwing (eventSyncProvider.test.ts's contract).
      await expect(provider.publish(event)).resolves.toBeUndefined()
      expect(chain.posted).toHaveLength(1)
      const prepared = await transport.getByEventId(event.eventId)
      expect((await repository.snapshot()).privateSyncOutbox).toEqual([])
      await provider.publish(event)
      expect(chain.posted).toHaveLength(1)
      expect(await transport.getByEventId(event.eventId)).toEqual(prepared)
      expect((await repository.snapshot()).privateSyncOutbox).toEqual([])
      expect((await repository.snapshot()).privateSyncDeliveries[0].envelope).toEqual(prepared)
    })

    it('quarantines a remote application collision and advances past the poison event', async () => {
      useFreshIndexedDb()
      const organizationId = 'org-chain-quarantine'
      const identity = new MockIdentityProvider('officer'), keys = new MockEpochKeyDistribution(organizationId)
      await keys.rotateEpoch([await identity.getPublicIdentity()])
      const repository = new MemoryRepository()
      const chain = fakeChain()
      const { wallet } = await fundedWallet(chain)
      const client = new WhatsOnChainTestnetClient(chain.fetcher as typeof fetch)
      const transport = new ChainPrivateHistoryProvider(wallet, client, organizationId, { dbName: 'chain-test-ac5-quarantine' })
      chain.watch(unitAnchorAddress(organizationId))
      const unsigned = { protocol: 'ARGUS' as const, protocolVersion: 1 as const, organizationId, eventVersion: 1 as const, eventId: 'event-quarantine', eventType: 'ITEM_ISSUED' as const, entityId: 'item-a', actorPublicIdentity: await identity.getPublicIdentity(), timestamp: '2026-09-27T00:00:00.000Z', baseVersion: 0, payload: { quantity: 1 }, signature: 'placeholder' }
      const event = unsigned as SignedArgusEvent
      await transport.publish(await encryptEvent(event, identity, keys))

      const engine = new PrivateSyncEngine({ providerId: 'test', repository, provider: transport, identity, keys, organizationId, validateAndApply: () => { throw new Error('EVENT_COLLISION') } })
      await engine.sync()
      const state = await repository.snapshot()
      expect(state.quarantine).toEqual([expect.objectContaining({ eventId: event.eventId, reason: 'EVENT_COLLISION' })])
    })
  })
})
