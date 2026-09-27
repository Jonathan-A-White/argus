import { canonicalize } from '../distributed/canonical'
import type { ArgusIdentityProvider } from '../identity/identity'
import { EPOCH_KEYS_STORE_NAME, INDEXED_DB_NAME, INDEXED_DB_VERSION, ensureArgusObjectStores } from '../storage/repository'
import { unsignedKeyGrantFields, unwrapEpochKeyFromGrant, wrapEpochKeyForGrant } from './keyGrant'
import type { KeyDistributionService } from './keys'
import { parseKeyGrantRecord } from './schema'
import type { EcdhKeyDirectory, KeyGrantChainProvider, KeyGrantRecord } from './types'

const EPOCH_ID_WIDTH = 3
const nextEpochId = (previous?: string) => `epoch-${String(Number(previous?.split('-')[1] ?? '0') + 1).padStart(EPOCH_ID_WIDTH, '0')}`

/**
 * Durable, best-effort cache of unwrapped epoch keys for this device. IndexedDB storage of a
 * CryptoKey works in every runtime this app targets, but the cache is an optimization, not a
 * correctness requirement: a store failure just means the next call re-derives the key.
 */
class EpochKeyCache {
  private memory = new Map<string, CryptoKey>()
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

  async get(key: string): Promise<CryptoKey | undefined> {
    const cached = this.memory.get(key)
    if (cached) return cached
    try {
      const db = await this.open()
      const record = await new Promise<CryptoKey | undefined>((resolve, reject) => {
        const request = db.transaction(EPOCH_KEYS_STORE_NAME).objectStore(EPOCH_KEYS_STORE_NAME).get(key)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      if (record) this.memory.set(key, record)
      return record
    } catch { return undefined }
  }

  async put(key: string, value: CryptoKey): Promise<void> {
    this.memory.set(key, value)
    try {
      const db = await this.open()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(EPOCH_KEYS_STORE_NAME, 'readwrite')
        tx.objectStore(EPOCH_KEYS_STORE_NAME).put(value, key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } catch { /* best-effort persistence; the in-memory cache above still serves this session */ }
  }
}

/**
 * Reads and writes ARGUS_KEY_GRANT records over a chain provider. Each device instance holds only
 * its own ECDH keypair, so keyFor can unwrap grants addressed to its own identity; it cannot act on
 * behalf of another device. Only grants signed by, and attributed to, the pinned Master are trusted.
 *
 * grantHistory and revoke are synchronous per KeyDistributionService (matching Mock and
 * DevelopmentPersistent), but chain publication is asynchronous: both enqueue their chain writes on
 * an internal serialized queue and return immediately. Callers who need to observe completion (tests,
 * or composition code that wants to know a rotation has actually landed) await flush().
 */
export class ChainKeyDistribution implements KeyDistributionService {
  private readonly cache: EpochKeyCache
  private readonly validGrants: KeyGrantRecord[] = []
  private cursor = '0'
  private syncing?: Promise<void>
  private pending: Promise<void> = Promise.resolve()
  private lastError?: unknown
  private authorizedIdentities: string[] = []

  constructor(
    private readonly organizationId: string,
    private readonly masterPublicIdentity: string,
    private readonly localIdentity: string,
    private readonly localEcdh: CryptoKeyPair,
    private readonly verifier: ArgusIdentityProvider,
    private readonly directory: EcdhKeyDirectory,
    private readonly provider: KeyGrantChainProvider,
    private readonly signer?: ArgusIdentityProvider,
    dependencies: { dbName?: string } = {},
  ) {
    this.cache = new EpochKeyCache(dependencies.dbName)
  }

  private cacheKey(epochId: string) { return `${this.organizationId}:${this.localIdentity}:${epochId}` }
  private requireMaster() { if (this.localIdentity !== this.masterPublicIdentity || !this.signer) throw new Error('Unauthorized: only the Master may rotate the encryption epoch.') }

  private enqueue(task: () => Promise<void>) {
    this.pending = this.pending.then(async () => {
      try { await task(); this.lastError = undefined }
      catch (error) { this.lastError = error }
    })
  }

  /** Awaits every chain write enqueued so far (by rotateEpoch, grantHistory, or revoke), rethrowing the most recent failure. */
  async flush(): Promise<void> {
    await this.pending
    if (this.lastError !== undefined) { const error = this.lastError; this.lastError = undefined; throw error }
  }

  /**
   * Rescans the chain's key-grant records for this organization, verifying each grant's signature
   * and its issuer's pin before trusting it (AC4: a grant from anyone but the pinned Master is
   * ignored). Safe to call repeatedly; already-seen grants are not reprocessed.
   */
  async sync(): Promise<void> {
    if (this.syncing) return this.syncing
    this.syncing = (async () => {
      let hasMore = true
      while (hasMore) {
        const page = await this.provider.getKeyGrantsSince(this.cursor)
        for (const raw of page.records) {
          let record: KeyGrantRecord
          try { record = parseKeyGrantRecord(raw) } catch { continue }
          if (record.organizationId !== this.organizationId) continue
          if (record.grantorPublicIdentity !== this.masterPublicIdentity) continue
          const valid = await this.verifier.verify(canonicalize(unsignedKeyGrantFields(record)), record.signature, record.grantorPublicIdentity)
          if (!valid) continue
          if (!this.validGrants.some(existing => existing.granteePublicIdentity === record.granteePublicIdentity && existing.epochId === record.epochId)) {
            this.validGrants.push(record)
          }
        }
        this.cursor = page.cursor
        hasMore = Boolean(page.hasMore)
      }
    })()
    try { await this.syncing } finally { this.syncing = undefined }
  }

  private latestEpochFor(identity: string): string | undefined {
    return this.validGrants.filter(grant => grant.granteePublicIdentity === identity).map(grant => grant.epochId).sort().at(-1)
  }

  currentEpoch(): string {
    const epoch = this.latestEpochFor(this.localIdentity)
    if (!epoch) throw new Error('No encryption epoch exists.')
    return epoch
  }

  async keyFor(identity: string, epochId: string): Promise<CryptoKey> {
    if (identity !== this.localIdentity) throw new Error(`NO_EPOCH_KEY: this device cannot unwrap a grant addressed to ${identity}.`)
    const cached = await this.cache.get(this.cacheKey(epochId))
    if (cached) return cached
    await this.sync()
    const grant = this.validGrants.find(candidate => candidate.granteePublicIdentity === identity && candidate.epochId === epochId)
    if (!grant) throw new Error(`NO_EPOCH_KEY: no key grant is available for ${identity} at ${epochId}.`)
    const grantorEcdhPublicKey = grant.grantorPublicIdentity === this.localIdentity ? this.localEcdh.publicKey : await this.directory.publicKeyFor(grant.grantorPublicIdentity)
    const key = await unwrapEpochKeyFromGrant(grant, { granteeEcdhPrivateKey: this.localEcdh.privateKey, grantorEcdhPublicKey })
    await this.cache.put(this.cacheKey(epochId), key)
    return key
  }

  /** Master only. Generates a fresh epoch key and publishes one grant per authorized identity. */
  async rotateEpoch(authorizedIdentities: string[]): Promise<string> {
    this.requireMaster()
    await this.sync()
    const epochId = nextEpochId(this.validGrants.filter(grant => grant.organizationId === this.organizationId).map(grant => grant.epochId).sort().at(-1))
    const epochKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    for (const identity of authorizedIdentities) {
      const granteeEcdhPublicKey = identity === this.localIdentity ? this.localEcdh.publicKey : await this.directory.publicKeyFor(identity)
      const record = await wrapEpochKeyForGrant({
        epochKey,
        organizationId: this.organizationId,
        epochId,
        granteePublicIdentity: identity,
        grantorPublicIdentity: this.masterPublicIdentity,
        grantorEcdhPrivateKey: this.localEcdh.privateKey,
        granteeEcdhPublicKey,
        grantorSigner: this.signer!,
      })
      await this.provider.publishKeyGrant(record)
      this.validGrants.push(record)
    }
    if (authorizedIdentities.includes(this.localIdentity)) await this.cache.put(this.cacheKey(epochId), epochKey)
    this.authorizedIdentities = [...authorizedIdentities]
    return epochId
  }

  /** Master only, synchronous per KeyDistributionService: validates immediately, publishes on the internal queue (see flush()). */
  grantHistory(identity: string, epochIds: string[]): void {
    this.requireMaster()
    const known = new Set(this.validGrants.filter(grant => grant.organizationId === this.organizationId).map(grant => grant.epochId))
    if (epochIds.some(epochId => !known.has(epochId))) throw new Error('Unknown encryption epoch.')
    const signer = this.signer!
    this.enqueue(async () => {
      for (const epochId of epochIds) {
        const epochKey = await this.cache.get(this.cacheKey(epochId))
        if (!epochKey) throw new Error(`This device does not hold the key material for ${epochId}.`)
        const granteeEcdhPublicKey = identity === this.localIdentity ? this.localEcdh.publicKey : await this.directory.publicKeyFor(identity)
        const record = await wrapEpochKeyForGrant({
          epochKey,
          organizationId: this.organizationId,
          epochId,
          granteePublicIdentity: identity,
          grantorPublicIdentity: this.masterPublicIdentity,
          grantorEcdhPrivateKey: this.localEcdh.privateKey,
          granteeEcdhPublicKey,
          grantorSigner: signer,
        })
        await this.provider.publishKeyGrant(record)
        this.validGrants.push(record)
      }
    })
  }

  /** Master only, synchronous per KeyDistributionService: rotates immediately (on the internal queue) to every previously authorized identity except this one. */
  revoke(identity: string): void {
    this.requireMaster()
    const remaining = this.authorizedIdentities.filter(existing => existing !== identity)
    this.enqueue(async () => { await this.rotateEpoch(remaining) })
  }
}
