import { IDBFactory } from 'fake-indexeddb'
import { afterEach, describe, expect, it } from 'vitest'
import { TESTNET_MERKLE_FIXTURE } from './fixtures/testnetMerkleProof'
import { HeaderCache, inclusionStatus, parseBlockHeader, verifyMerkleProof, type TscMerkleProof } from './spv'

const originalIndexedDb = globalThis.indexedDB

function useFreshIndexedDb() {
  const factory = new IDBFactory()
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: factory })
  return factory
}

afterEach(() => Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: originalIndexedDb }))

describe('verifyMerkleProof', () => {
  it('accepts the committed real testnet fixture', async () => {
    const { transactionId, proof, merkleRoot } = TESTNET_MERKLE_FIXTURE
    expect(await verifyMerkleProof(transactionId, proof, merkleRoot)).toBe(true)
  })

  it('rejects the same proof with one node byte altered', async () => {
    const { transactionId, proof, merkleRoot } = TESTNET_MERKLE_FIXTURE
    const tampered: TscMerkleProof = { ...proof, nodes: [proof.nodes[0].replace(/^95/, '96')] }
    expect(await verifyMerkleProof(transactionId, tampered, merkleRoot)).toBe(false)
  })

  it('rejects the proof against the wrong merkle root', async () => {
    const { transactionId, proof } = TESTNET_MERKLE_FIXTURE
    const wrongRoot = '0'.repeat(63) + '1'
    expect(await verifyMerkleProof(transactionId, proof, wrongRoot)).toBe(false)
  })

  it('treats a "*" node as duplicating the current hash regardless of index parity', async () => {
    const txId = 'aa'.repeat(32)
    const leaf = Uint8Array.from(txId.match(/.{2}/g)!.map(byte => Number.parseInt(byte, 16))).reverse()
    const doubled = new Uint8Array(64)
    doubled.set(leaf, 0); doubled.set(leaf, 32)
    const once = new Uint8Array(await crypto.subtle.digest('SHA-256', doubled))
    const twice = new Uint8Array(await crypto.subtle.digest('SHA-256', once))
    const expectedRoot = Array.from(twice.slice().reverse(), byte => byte.toString(16).padStart(2, '0')).join('')

    const proofEven: TscMerkleProof = { index: 0, txOrId: txId, target: 'unused', nodes: ['*'] }
    const proofOdd: TscMerkleProof = { index: 1, txOrId: txId, target: 'unused', nodes: ['*'] }
    expect(await verifyMerkleProof(txId, proofEven, expectedRoot)).toBe(true)
    expect(await verifyMerkleProof(txId, proofOdd, expectedRoot)).toBe(true)
  })
})

describe('parseBlockHeader', () => {
  it('yields the fixture header hash and merkle root', async () => {
    const parsed = await parseBlockHeader(TESTNET_MERKLE_FIXTURE.headerHex)
    expect(parsed.hash).toBe(TESTNET_MERKLE_FIXTURE.blockHash)
    expect(parsed.merkleRoot).toBe(TESTNET_MERKLE_FIXTURE.merkleRoot)
  })
})

describe('HeaderCache', () => {
  it('round-trips a header record through fake-indexeddb', async () => {
    useFreshIndexedDb()
    const writer = new HeaderCache('spv-roundtrip')
    await writer.put({ hash: TESTNET_MERKLE_FIXTURE.blockHash, headerHex: TESTNET_MERKLE_FIXTURE.headerHex, height: TESTNET_MERKLE_FIXTURE.blockHeight, verifiedAt: '2026-09-27T00:00:00.000Z' })
    writer.close()
    const reader = new HeaderCache('spv-roundtrip')
    const record = await reader.get(TESTNET_MERKLE_FIXTURE.blockHash)
    expect(record).toEqual({ hash: TESTNET_MERKLE_FIXTURE.blockHash, headerHex: TESTNET_MERKLE_FIXTURE.headerHex, height: TESTNET_MERKLE_FIXTURE.blockHeight, verifiedAt: '2026-09-27T00:00:00.000Z' })
    reader.close()
  })

  it('returns undefined for a hash it has never seen', async () => {
    useFreshIndexedDb()
    const cache = new HeaderCache('spv-empty')
    expect(await cache.get('ff'.repeat(32))).toBeUndefined()
    cache.close()
  })
})

describe('inclusionStatus', () => {
  it('reports BROADCAST when no block height is known', async () => {
    useFreshIndexedDb()
    const cache = new HeaderCache('spv-status-broadcast')
    expect(await inclusionStatus({ transactionId: TESTNET_MERKLE_FIXTURE.transactionId }, cache)).toBe('BROADCAST')
  })

  it('reports INCLUSION_UNVERIFIED when the height is known but no proof has arrived', async () => {
    useFreshIndexedDb()
    const cache = new HeaderCache('spv-status-unverified')
    expect(await inclusionStatus({ transactionId: TESTNET_MERKLE_FIXTURE.transactionId, blockHeight: TESTNET_MERKLE_FIXTURE.blockHeight }, cache)).toBe('INCLUSION_UNVERIFIED')
  })

  it('fetches the header through the client once and reads the cache on a second call', async () => {
    useFreshIndexedDb()
    const cache = new HeaderCache('spv-status-fetch-once')
    let calls = 0
    const client = { fetchHeader: async (hash: string) => { calls += 1; expect(hash).toBe(TESTNET_MERKLE_FIXTURE.blockHash); return TESTNET_MERKLE_FIXTURE.headerHex } }
    const record = { transactionId: TESTNET_MERKLE_FIXTURE.transactionId, blockHeight: TESTNET_MERKLE_FIXTURE.blockHeight, merkleProof: TESTNET_MERKLE_FIXTURE.proof }

    expect(await inclusionStatus(record, cache, client)).toBe('MERKLE_PROOF_PRESENT')
    expect(await inclusionStatus(record, cache, client)).toBe('MERKLE_PROOF_PRESENT')
    expect(calls).toBe(1)
  })

  it('reports INCLUSION_UNVERIFIED instead of trusting a proof when no client is available to fetch its header', async () => {
    useFreshIndexedDb()
    const cache = new HeaderCache('spv-status-no-client')
    const record = { transactionId: TESTNET_MERKLE_FIXTURE.transactionId, blockHeight: TESTNET_MERKLE_FIXTURE.blockHeight, merkleProof: TESTNET_MERKLE_FIXTURE.proof }
    expect(await inclusionStatus(record, cache)).toBe('INCLUSION_UNVERIFIED')
  })

  it('reports INCLUSION_UNVERIFIED when the cached header does not verify the proof', async () => {
    useFreshIndexedDb()
    const cache = new HeaderCache('spv-status-tampered')
    const tampered: TscMerkleProof = { ...TESTNET_MERKLE_FIXTURE.proof, nodes: [TESTNET_MERKLE_FIXTURE.proof.nodes[0].replace(/^95/, '96')] }
    const client = { fetchHeader: async () => TESTNET_MERKLE_FIXTURE.headerHex }
    const record = { transactionId: TESTNET_MERKLE_FIXTURE.transactionId, blockHeight: TESTNET_MERKLE_FIXTURE.blockHeight, merkleProof: tampered }
    expect(await inclusionStatus(record, cache, client)).toBe('INCLUSION_UNVERIFIED')
  })
})
