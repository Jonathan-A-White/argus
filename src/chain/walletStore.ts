/**
 * Persistence for DeviceWallet state. Each wallet's state is ONE record keyed by its address,
 * so every save is atomic.
 */

import type { WalletState, WalletStateStore } from './types'

export const DEFAULT_WALLET_DB_NAME = 'argus-unit-wallet'
const OBJECT_STORE = 'wallet'
const DB_VERSION = 1

/** In-memory store for tests and ephemeral sessions. Clones on the way in and out, like IndexedDB. */
export class MemoryWalletStateStore implements WalletStateStore {
  private readonly states = new Map<string, WalletState>()
  /** Number of successful saves, handy for asserting "one atomic save". */
  saveCount = 0

  async load(address: string): Promise<WalletState | undefined> {
    const state = this.states.get(address)
    return state ? structuredClone(state) : undefined
  }

  async save(state: WalletState): Promise<void> {
    this.states.set(state.address, structuredClone(state))
    this.saveCount += 1
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'))
  })
}

function isWalletState(value: unknown): value is WalletState {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<WalletState>
  return candidate.version === 1 && typeof candidate.address === 'string' && Array.isArray(candidate.coins) && Array.isArray(candidate.pending) && Array.isArray(candidate.recent)
}

/**
 * IndexedDB store in its own database (default "argus-unit-wallet", object store "wallet",
 * keyPath "address"), deliberately separate from the app's other databases so wallet state
 * never rides on another schema's upgrades.
 */
export class IndexedDbWalletStateStore implements WalletStateStore {
  private database: Promise<IDBDatabase> | undefined
  private readonly dbName: string
  private readonly factory: IDBFactory | undefined

  constructor(dbName: string = DEFAULT_WALLET_DB_NAME, factory?: IDBFactory) {
    this.dbName = dbName
    this.factory = factory
  }

  async load(address: string): Promise<WalletState | undefined> {
    const db = await this.open()
    const transaction = db.transaction(OBJECT_STORE, 'readonly')
    const value: unknown = await requestResult(transaction.objectStore(OBJECT_STORE).get(address))
    if (value === undefined) return undefined
    if (!isWalletState(value)) throw new Error(`Stored wallet state for ${address} is damaged or from an unknown version.`)
    return value
  }

  async save(state: WalletState): Promise<void> {
    const db = await this.open()
    const transaction = db.transaction(OBJECT_STORE, 'readwrite')
    const done = transactionDone(transaction)
    transaction.objectStore(OBJECT_STORE).put(state)
    // Resolve only once the transaction commits, not when the put request succeeds.
    await done
  }

  /** Closes the connection; the next load/save reopens it. */
  async close(): Promise<void> {
    const pending = this.database
    this.database = undefined
    if (pending) (await pending).close()
  }

  private open(): Promise<IDBDatabase> {
    if (!this.database) {
      this.database = this.openDatabase().catch((error: unknown) => {
        this.database = undefined
        throw error
      })
    }
    return this.database
  }

  private openDatabase(): Promise<IDBDatabase> {
    const factory = this.factory ?? globalThis.indexedDB
    if (!factory) return Promise.reject(new Error('IndexedDB is not available, so the device wallet cannot be stored.'))
    return new Promise((resolve, reject) => {
      const request = factory.open(this.dbName, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(OBJECT_STORE)) db.createObjectStore(OBJECT_STORE, { keyPath: 'address' })
      }
      request.onsuccess = () => {
        const db = request.result
        // Let a future schema upgrade (e.g. in another tab) proceed instead of blocking on us.
        db.onversionchange = () => {
          db.close()
          this.database = undefined
        }
        resolve(db)
      }
      request.onerror = () => reject(request.error ?? new Error(`Could not open IndexedDB database ${this.dbName}.`))
    })
  }
}
