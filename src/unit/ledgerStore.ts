import type { UnitEnvelope } from './envelope'

/**
 * Durable, device-local copy of the unit's history — as ENCRYPTED envelopes only. Decrypted
 * events and projections (cadet names included) exist in memory while the device is unlocked
 * and are never written to disk, so a lost or shared device shows nothing without the passphrase.
 *
 * status: QUEUED     authored here, waiting for a wallet transaction
 *         PUBLISHING a transaction was built and is being broadcast (txid known)
 *         BROADCAST  the network accepted the transaction
 *         CONFIRMED  seen on the anchor history (height 0 = mempool, > 0 = mined)
 */
export type EnvelopeStatus = 'QUEUED' | 'PUBLISHING' | 'BROADCAST' | 'CONFIRMED'
export type StoredEnvelope = { eventId: string; envelope: UnitEnvelope; origin: 'local' | 'chain'; status: EnvelopeStatus; txid?: string; height?: number; addedAt: string; lastError?: string }
export type SeenTransaction = { txid: string; height: number; eventIds: string[]; scannedAt: string }
export type ScanCursor = { confirmedHeight: number; lastScanAt?: string; lastError?: string }

export interface LedgerStore {
  envelopes(): Promise<StoredEnvelope[]>
  envelope(eventId: string): Promise<StoredEnvelope | undefined>
  /** Inserts when new; never replaces an existing envelope's bytes (exact-once identity). Returns false if the event ID already exists. */
  addEnvelope(value: StoredEnvelope): Promise<boolean>
  updateEnvelopes(eventIds: string[], change: Partial<Pick<StoredEnvelope, 'status' | 'txid' | 'height' | 'lastError'>> & { clearTxid?: boolean }): Promise<void>
  seen(txid: string): Promise<SeenTransaction | undefined>
  markSeen(value: SeenTransaction): Promise<void>
  cursor(): Promise<ScanCursor>
  setCursor(value: ScanCursor): Promise<void>
}

const clone = <T,>(value: T): T => structuredClone(value)
function applyChange(record: StoredEnvelope, change: Parameters<LedgerStore['updateEnvelopes']>[1]) {
  const { clearTxid, ...rest } = change
  Object.assign(record, rest)
  if (clearTxid) { delete record.txid; delete record.height }
}

export class MemoryLedgerStore implements LedgerStore {
  private readonly items = new Map<string, StoredEnvelope>()
  private readonly transactions = new Map<string, SeenTransaction>()
  private scan: ScanCursor = { confirmedHeight: 0 }
  async envelopes() { return [...this.items.values()].map(clone) }
  async envelope(eventId: string) { const value = this.items.get(eventId); return value && clone(value) }
  async addEnvelope(value: StoredEnvelope) { if (this.items.has(value.eventId)) return false; this.items.set(value.eventId, clone(value)); return true }
  async updateEnvelopes(eventIds: string[], change: Parameters<LedgerStore['updateEnvelopes']>[1]) { for (const id of eventIds) { const record = this.items.get(id); if (record) applyChange(record, change) } }
  async seen(txid: string) { const value = this.transactions.get(txid); return value && clone(value) }
  async markSeen(value: SeenTransaction) { this.transactions.set(value.txid, clone(value)) }
  async cursor() { return clone(this.scan) }
  async setCursor(value: ScanCursor) { this.scan = clone(value) }
}

const ENVELOPES = 'envelopes', SEEN = 'seenTransactions', META = 'meta'
/** One IndexedDB database per unit, separate from any legacy A.R.G.U.S. database. */
export class IndexedDbLedgerStore implements LedgerStore {
  private db?: Promise<IDBDatabase>
  constructor(private readonly unitId: string, private readonly factory: IDBFactory = globalThis.indexedDB) {
    if (!factory) throw new Error('This browser does not provide IndexedDB; A.R.G.U.S. cannot keep an offline copy.')
  }
  static databaseName(unitId: string) { return `argus-unit-ledger-${unitId}` }
  private open() {
    return this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(IndexedDbLedgerStore.databaseName(this.unitId), 1)
      request.onupgradeneeded = () => { const db = request.result; for (const name of [ENVELOPES, SEEN, META]) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name) }
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result) }
      request.onerror = () => reject(new Error('A.R.G.U.S. could not open its offline ledger.', { cause: request.error }))
      request.onblocked = () => reject(new Error('Close other A.R.G.U.S. tabs and reload.'))
    })
  }
  private async run<T>(stores: string[], mode: IDBTransactionMode, body: (tx: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
    const db = await this.open()
    return new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(stores, mode); let result: T | undefined
      const request = body(tx); if (request) request.onsuccess = () => { result = request.result }
      tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error('Ledger transaction aborted.'))
    })
  }
  async envelopes() { return (await this.run<StoredEnvelope[]>([ENVELOPES], 'readonly', tx => tx.objectStore(ENVELOPES).getAll() as IDBRequest<StoredEnvelope[]>)) ?? [] }
  envelope(eventId: string) { return this.run<StoredEnvelope>([ENVELOPES], 'readonly', tx => tx.objectStore(ENVELOPES).get(eventId) as IDBRequest<StoredEnvelope>) }
  async addEnvelope(value: StoredEnvelope) {
    let added = false
    await this.run([ENVELOPES], 'readwrite', tx => { const store = tx.objectStore(ENVELOPES), request = store.getKey(value.eventId); request.onsuccess = () => { if (request.result === undefined) { store.put(value, value.eventId); added = true } } })
    return added
  }
  async updateEnvelopes(eventIds: string[], change: Parameters<LedgerStore['updateEnvelopes']>[1]) {
    await this.run([ENVELOPES], 'readwrite', tx => { const store = tx.objectStore(ENVELOPES); for (const id of eventIds) { const request = store.get(id) as IDBRequest<StoredEnvelope | undefined>; request.onsuccess = () => { if (request.result) { applyChange(request.result, change); store.put(request.result, id) } } } })
  }
  seen(txid: string) { return this.run<SeenTransaction>([SEEN], 'readonly', tx => tx.objectStore(SEEN).get(txid) as IDBRequest<SeenTransaction>) }
  async markSeen(value: SeenTransaction) { await this.run([SEEN], 'readwrite', tx => { tx.objectStore(SEEN).put(value, value.txid) }) }
  async cursor() { return (await this.run<ScanCursor>([META], 'readonly', tx => tx.objectStore(META).get('scan') as IDBRequest<ScanCursor>)) ?? { confirmedHeight: 0 } }
  async setCursor(value: ScanCursor) { await this.run([META], 'readwrite', tx => { tx.objectStore(META).put(value, 'scan') }) }
  async close() { (await this.db)?.close(); this.db = undefined }
}
