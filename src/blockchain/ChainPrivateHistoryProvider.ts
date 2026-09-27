import { Transaction } from '@bsv/sdk'
import { anchorLockingScript, unitAnchorAddress } from './anchor'
import { decodeEventOutput, encodeEventOutput } from './EncryptedEventTestnet'
import { HeaderCache, inclusionStatus, type InclusionStatus } from './spv'
import type { WhatsOnChainAddressHistoryEntry, WhatsOnChainTestnetClient } from './whatsonchain'
import { CHAIN_EVENTS_STORE_NAME, INDEXED_DB_NAME, INDEXED_DB_VERSION, ensureArgusObjectStores } from '../storage/repository'
import { parseEncryptedEnvelope } from '../private-sync/schema'
import type { EncryptedArgusEnvelope, HistoryPage, PrivateHistoryProvider, ProviderHealth, PublishResult } from '../private-sync/types'

const DATA_OUTPUT_SATOSHIS = 1
const ANCHOR_OUTPUT_SATOSHIS = 1
/** Conservative headroom above the two 1-satoshi outputs; the wallet's own fee model runs again inside createAction. */
const MIN_FEE_ESTIMATE_SATOSHIS = 200
const PAGE_LIMIT = 25

export class InsufficientFundsError extends Error {
  constructor(public readonly address: string, public readonly balance: number) {
    super(`Insufficient testnet funds at ${address} (balance ${balance} satoshis). Fund the wallet before publishing.`)
    this.name = 'InsufficientFundsError'
  }
}

export type ChainWalletStatus = { receivingAddress?: string; balanceSatoshis?: number }
/** The subset of EmbeddedTestnetWallet (or an equivalent BRC-100 wallet) this provider needs. */
export interface ChainPrivateHistoryWallet {
  getStatus(): Promise<ChainWalletStatus>
  createAction(args: { outputs: Array<{ lockingScript: string; satoshis: number }> }): Promise<{ txid?: string }>
}

type ChainEventRecord = { eventId: string; txid: string; height?: number; status: InclusionStatus }

type SortKey = { tier: 0 | 1; height: number; txid: string }
const sortKeyFor = (entry: WhatsOnChainAddressHistoryEntry): SortKey =>
  entry.height != null ? { tier: 0, height: entry.height, txid: entry.txHash } : { tier: 1, height: 0, txid: entry.txHash }
const compareSortKeys = (a: SortKey, b: SortKey): number =>
  a.tier !== b.tier ? a.tier - b.tier : a.height !== b.height ? a.height - b.height : a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0
const cursorFor = (entry: WhatsOnChainAddressHistoryEntry): string => `h:${entry.height ?? 'u'}:${entry.txHash}`

/** Extracts the OP_FALSE OP_RETURN data output from a raw transaction and decodes its envelope. */
function envelopeFromTxHex(hex: string): EncryptedArgusEnvelope {
  const tx = Transaction.fromHex(hex)
  for (const output of tx.outputs) {
    try { return decodeEventOutput(output.lockingScript.toHex()) } catch { continue }
  }
  throw new Error('Transaction does not contain an A.R.G.U.S. data output.')
}

/** Durable index over IndexedDB, keyed by eventId, with a small in-memory front. */
class ChainEventIndex {
  private memory = new Map<string, ChainEventRecord>()
  private db?: IDBDatabase

  constructor(private readonly name: string = INDEXED_DB_NAME) {}

  private open(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db)
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, INDEXED_DB_VERSION)
      request.onupgradeneeded = () => ensureArgusObjectStores(request.result)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => { this.db = request.result; resolve(request.result) }
    })
  }

  async get(eventId: string): Promise<ChainEventRecord | undefined> {
    const fromMemory = this.memory.get(eventId)
    if (fromMemory) return fromMemory
    const db = await this.open()
    const record = await new Promise<ChainEventRecord | undefined>((resolve, reject) => {
      const request = db.transaction(CHAIN_EVENTS_STORE_NAME).objectStore(CHAIN_EVENTS_STORE_NAME).get(eventId)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    if (record) this.memory.set(eventId, record)
    return record
  }

  async put(record: ChainEventRecord): Promise<void> {
    const db = await this.open()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CHAIN_EVENTS_STORE_NAME, 'readwrite')
      tx.objectStore(CHAIN_EVENTS_STORE_NAME).put(record, record.eventId)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    this.memory.set(record.eventId, record)
  }

  async count(): Promise<number> {
    const db = await this.open()
    return new Promise<number>((resolve, reject) => {
      const request = db.transaction(CHAIN_EVENTS_STORE_NAME).objectStore(CHAIN_EVENTS_STORE_NAME).count()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }

  close() { this.db?.close(); this.db = undefined }
}

/** Publishes and reads A.R.G.U.S. encrypted event envelopes anchored to the unit's testnet address. */
export class ChainPrivateHistoryProvider implements PrivateHistoryProvider {
  readonly name = 'whatsonchain-testnet'
  private readonly index: ChainEventIndex
  private readonly headerCache: HeaderCache
  /** In-memory only: decoding a tx twice in one session is wasted network, but the durable index intentionally does not carry ciphertext. */
  private readonly envelopeCache = new Map<string, EncryptedArgusEnvelope>()
  /** Txids this instance has already handed back from getSince; distinct from the durable index, which also holds our own not-yet-scanned publishes. */
  private readonly deliveredViaScan = new Set<string>()

  constructor(
    private readonly wallet: ChainPrivateHistoryWallet,
    private readonly client: WhatsOnChainTestnetClient,
    private readonly organizationId: string,
    dependencies: { dbName?: string } = {},
  ) {
    this.index = new ChainEventIndex(dependencies.dbName)
    this.headerCache = new HeaderCache(dependencies.dbName)
  }

  async publish(input: EncryptedArgusEnvelope): Promise<PublishResult> {
    const envelope = parseEncryptedEnvelope(input)
    const existing = await this.index.get(envelope.eventId)
    if (existing) {
      const existingEnvelope = await this.resolveEnvelopeForTx(existing.txid)
      if (existingEnvelope.ciphertextHash !== envelope.ciphertextHash) throw new Error('EVENT_COLLISION: encrypted event identity was reused.')
      return { accepted: true, duplicate: true, sequence: await this.index.count() }
    }

    const status = await this.wallet.getStatus()
    const address = status.receivingAddress ?? ''
    const balance = status.balanceSatoshis ?? 0
    if (balance < DATA_OUTPUT_SATOSHIS + ANCHOR_OUTPUT_SATOSHIS + MIN_FEE_ESTIMATE_SATOSHIS) throw new InsufficientFundsError(address, balance)

    const anchorAddress = unitAnchorAddress(this.organizationId)
    const result = await this.wallet.createAction({
      outputs: [
        { lockingScript: encodeEventOutput(envelope), satoshis: DATA_OUTPUT_SATOSHIS },
        { lockingScript: anchorLockingScript(anchorAddress).toHex(), satoshis: ANCHOR_OUTPUT_SATOSHIS },
      ],
    })
    if (!result.txid || !/^[0-9a-f]{64}$/i.test(result.txid)) throw new Error('Testnet wallet did not durably acknowledge a transaction ID; query before retrying.')

    this.envelopeCache.set(result.txid, envelope)
    await this.index.put({ eventId: envelope.eventId, txid: result.txid, status: 'BROADCAST' })
    return { accepted: true, duplicate: false, sequence: await this.index.count() }
  }

  async getSince(cursor = '0'): Promise<HistoryPage> {
    const anchorAddress = unitAnchorAddress(this.organizationId)
    const history = await this.client.addressHistory(anchorAddress)
    const ordered = [...history].sort((a, b) => compareSortKeys(sortKeyFor(a), sortKeyFor(b)))

    // "Already indexed" here means already handed back by a previous getSince call on this instance,
    // not merely known from our own publish(): a self-published event must still flow back through
    // getSince so other replicas (and this replica's own remote-application projection) see it.
    const novel = ordered.filter(entry => !this.deliveredViaScan.has(entry.txHash))

    const page = novel.slice(0, PAGE_LIMIT)
    const envelopes: EncryptedArgusEnvelope[] = []
    for (const entry of page) {
      const envelope = await this.resolveEnvelopeForTx(entry.txHash)
      const status = await inclusionStatus({ transactionId: entry.txHash, blockHeight: entry.height ?? undefined }, this.headerCache)
      await this.index.put({ eventId: envelope.eventId, txid: entry.txHash, height: entry.height ?? undefined, status })
      this.deliveredViaScan.add(entry.txHash)
      envelopes.push(envelope)
    }

    const last = page[page.length - 1]
    return { envelopes, cursor: last ? cursorFor(last) : cursor, hasMore: novel.length > PAGE_LIMIT }
  }

  async getByEventId(eventId: string): Promise<EncryptedArgusEnvelope | undefined> {
    const record = await this.index.get(eventId)
    if (!record) return undefined
    return this.resolveEnvelopeForTx(record.txid)
  }

  async health(): Promise<ProviderHealth> {
    await this.client.chainInfo()
    return { ok: true, provider: this.name, protocolVersion: 1 }
  }

  private async resolveEnvelopeForTx(txid: string): Promise<EncryptedArgusEnvelope> {
    const cached = this.envelopeCache.get(txid)
    if (cached) return cached
    const hex = await this.client.txHex(txid)
    const envelope = envelopeFromTxHex(hex)
    this.envelopeCache.set(txid, envelope)
    return envelope
  }
}
