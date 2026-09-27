import { CHAIN_HEADERS_STORE_NAME, INDEXED_DB_NAME, INDEXED_DB_VERSION, ensureArgusObjectStores } from '../storage/repository'

/** The TSC merkle proof standard's 'nodes' entries: a sibling hash, or '*' to duplicate the current hash. */
export type TscMerkleProof = { index: number; txOrId: string; target: string; targetType?: 'hash' | 'merkleRoot' | 'header'; nodes: string[] }
export type ParsedBlockHeader = { hash: string; prevHash: string; merkleRoot: string; time: number; height?: number }
export type CachedHeaderRecord = { hash: string; headerHex: string; height?: number; verifiedAt: string }
export type InclusionRecord = { transactionId: string; blockHeight?: number; merkleProof?: TscMerkleProof }
export type InclusionStatus = 'BROADCAST' | 'INCLUSION_UNVERIFIED' | 'MERKLE_PROOF_PRESENT'
export interface HeaderFetchClient {
  fetchHeader(blockHash: string): Promise<string>
}

const hexOf = (bytes: Uint8Array<ArrayBuffer>) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
const bytesOf = (value: string): Uint8Array<ArrayBuffer> => Uint8Array.from(value.match(/.{2}/g) ?? [], byte => Number.parseInt(byte, 16))
const reversed = (bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> => Uint8Array.from(bytes).reverse()

async function sha256d(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const once = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return new Uint8Array(await crypto.subtle.digest('SHA-256', once))
}

/** Recomputes the merkle root from a leaf transaction ID and its TSC proof nodes, sha256d pairwise up to the root. */
export async function verifyMerkleProof(txId: string, proof: TscMerkleProof, merkleRoot: string): Promise<boolean> {
  if (proof.txOrId.toLowerCase() !== txId.toLowerCase()) return false
  let current = reversed(bytesOf(txId))
  let index = proof.index
  for (const node of proof.nodes) {
    const sibling = node === '*' ? current : reversed(bytesOf(node))
    const combined = new Uint8Array(64)
    if (index % 2 === 0) { combined.set(current, 0); combined.set(sibling, 32) }
    else { combined.set(sibling, 0); combined.set(current, 32) }
    current = await sha256d(combined)
    index = Math.floor(index / 2)
  }
  return hexOf(reversed(current)) === merkleRoot.toLowerCase()
}

/** Parses the raw 80-byte block header. height is not encoded in the header and is left undefined. */
export async function parseBlockHeader(headerHex: string): Promise<ParsedBlockHeader> {
  const bytes = bytesOf(headerHex)
  if (bytes.length !== 80) throw new Error('A block header must be exactly 80 bytes.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const hash = await sha256d(bytes)
  return {
    hash: hexOf(reversed(hash)),
    prevHash: hexOf(reversed(bytes.slice(4, 36))),
    merkleRoot: hexOf(reversed(bytes.slice(36, 68))),
    time: view.getUint32(68, true),
  }
}

/** Header cache over IndexedDB, keyed by block hash, with a small in-memory front. */
export class HeaderCache {
  private memory = new Map<string, CachedHeaderRecord>()
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

  async get(hash: string): Promise<CachedHeaderRecord | undefined> {
    const fromMemory = this.memory.get(hash)
    if (fromMemory) return fromMemory
    const db = await this.open()
    const record = await new Promise<CachedHeaderRecord | undefined>((resolve, reject) => {
      const request = db.transaction(CHAIN_HEADERS_STORE_NAME).objectStore(CHAIN_HEADERS_STORE_NAME).get(hash)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    if (record) this.memory.set(hash, record)
    return record
  }

  async put(record: CachedHeaderRecord): Promise<void> {
    const db = await this.open()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CHAIN_HEADERS_STORE_NAME, 'readwrite')
      tx.objectStore(CHAIN_HEADERS_STORE_NAME).put(record, record.hash)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    this.memory.set(record.hash, record)
  }

  close() { this.db?.close(); this.db = undefined }
}

/** Never trusts a proof without its header: the header is fetched through the client once, cached, then re-verified every call. */
export async function inclusionStatus(record: InclusionRecord, cache: HeaderCache, client?: HeaderFetchClient): Promise<InclusionStatus> {
  if (record.blockHeight === undefined) return 'BROADCAST'
  if (!record.merkleProof) return 'INCLUSION_UNVERIFIED'
  const blockHash = record.merkleProof.target
  let cached = await cache.get(blockHash)
  if (!cached) {
    if (!client) return 'INCLUSION_UNVERIFIED'
    const headerHex = await client.fetchHeader(blockHash)
    cached = { hash: blockHash, headerHex, height: record.blockHeight, verifiedAt: new Date().toISOString() }
    await cache.put(cached)
  }
  const header = await parseBlockHeader(cached.headerHex)
  const verified = await verifyMerkleProof(record.transactionId, record.merkleProof, header.merkleRoot)
  return verified ? 'MERKLE_PROOF_PRESENT' : 'INCLUSION_UNVERIFIED'
}
