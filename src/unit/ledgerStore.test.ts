import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import type { UnitEnvelope } from './envelope'
import { IndexedDbLedgerStore, MemoryLedgerStore, type LedgerStore } from './ledgerStore'

const envelope = (eventId: string): UnitEnvelope => ({ v: 2, unit: 'u-test', epoch: 'e1', eventId, z: 0, nonce: 'bm9uY2U=', ct: 'Y2lwaGVy' })
const stores: Array<[string, () => LedgerStore]> = [['memory', () => new MemoryLedgerStore()], ['IndexedDB', () => new IndexedDbLedgerStore(`u-${crypto.randomUUID()}`, new IDBFactory())]]

describe.each(stores)('%s ledger store', (_name, create) => {
  it('stores ciphertext envelopes exactly once and tracks their publication status', async () => {
    const store = create()
    expect(await store.addEnvelope({ eventId: 'a', envelope: envelope('a'), origin: 'local', status: 'QUEUED', addedAt: '2026-09-27T00:00:00.000Z' })).toBe(true)
    // A second add with the same event ID never replaces the stored bytes.
    expect(await store.addEnvelope({ eventId: 'a', envelope: { ...envelope('a'), ct: 'b3RoZXI=' }, origin: 'chain', status: 'CONFIRMED', addedAt: '2026-09-27T00:00:01.000Z' })).toBe(false)
    expect((await store.envelope('a'))?.envelope.ct).toBe('Y2lwaGVy')
    await store.updateEnvelopes(['a'], { status: 'PUBLISHING', txid: 'f'.repeat(64) })
    expect(await store.envelope('a')).toMatchObject({ status: 'PUBLISHING', txid: 'f'.repeat(64) })
    await store.updateEnvelopes(['a'], { status: 'QUEUED', clearTxid: true, lastError: 'rolled back' })
    const rolledBack = await store.envelope('a')
    expect(rolledBack).toMatchObject({ status: 'QUEUED', lastError: 'rolled back' })
    expect(rolledBack?.txid).toBeUndefined()
    expect((await store.envelopes()).map(record => record.eventId)).toEqual(['a'])
  })

  it('remembers scanned transactions and the scan cursor', async () => {
    const store = create()
    expect(await store.cursor()).toEqual({ confirmedHeight: 0 })
    await store.markSeen({ txid: 't1', height: 0, eventIds: ['a'], scannedAt: 'now' })
    await store.setCursor({ confirmedHeight: 120, lastScanAt: 'now' })
    expect(await store.seen('t1')).toMatchObject({ eventIds: ['a'], height: 0 })
    expect(await store.seen('missing')).toBeUndefined()
    expect(await store.cursor()).toEqual({ confirmedHeight: 120, lastScanAt: 'now' })
  })
})
