import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { FakeChain, fakeAddress } from './fakeChain'
import type { WalletState } from './types'
import { DeviceWallet } from './wallet'
import { DEFAULT_WALLET_DB_NAME, IndexedDbWalletStateStore, MemoryWalletStateStore } from './walletStore'

let dbCounter = 0
const freshDbName = () => `argus-unit-wallet-test-${(dbCounter += 1)}`

function sampleState(address = fakeAddress()): WalletState {
  return {
    version: 1,
    address,
    coins: [{ txid: 'a'.repeat(64), vout: 1, satoshis: 500, height: 0, origin: 'change', sourceTxHex: '00', spentBy: 'b'.repeat(64) }],
    pending: [{ txid: 'b'.repeat(64), hex: '01', createdAt: '2026-09-27T00:00:00.000Z', purpose: 'records', correlationIds: ['e1'], feeSatPerKb: 1, attempts: 0, status: 'pending' }],
    recent: [],
    lastRefreshAt: '2026-09-27T00:00:00.000Z',
    feeSatPerKb: 10,
  }
}

function openRaw(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

describe('MemoryWalletStateStore', () => {
  it('round-trips state by address and isolates callers from its copy', async () => {
    const store = new MemoryWalletStateStore()
    const state = sampleState()
    expect(await store.load(state.address)).toBeUndefined()

    await store.save(state)
    state.coins[0].satoshis = 1 // mutating after save must not leak in
    const loaded = await store.load(state.address)
    expect(loaded?.coins[0].satoshis).toBe(500)

    if (loaded) loaded.pending = [] // nor may mutating a loaded copy
    expect((await store.load(state.address))?.pending).toHaveLength(1)
    expect(store.saveCount).toBe(1)
  })
})

describe('IndexedDbWalletStateStore', () => {
  it('uses its own database with a "wallet" store keyed by address', async () => {
    expect(DEFAULT_WALLET_DB_NAME).toBe('argus-unit-wallet')
    const name = freshDbName()
    const store = new IndexedDbWalletStateStore(name)
    const state = sampleState()
    await store.save(state)
    await store.close()

    const raw = await openRaw(name)
    expect([...raw.objectStoreNames]).toEqual(['wallet'])
    const objectStore = raw.transaction('wallet', 'readonly').objectStore('wallet')
    expect(objectStore.keyPath).toBe('address')
    raw.close()
  })

  it('saves, overwrites and loads whole states, separately per address', async () => {
    const store = new IndexedDbWalletStateStore(freshDbName())
    const first = sampleState()
    const second = sampleState()
    await store.save(first)
    await store.save(second)
    await store.save({ ...first, pending: [], feeSatPerKb: 50 })

    expect(await store.load(first.address)).toEqual({ ...first, pending: [], feeSatPerKb: 50 })
    expect(await store.load(second.address)).toEqual(second)
    expect(await store.load(fakeAddress())).toBeUndefined()
    await store.close()
  })

  it('survives reopening and refuses a damaged record', async () => {
    const name = freshDbName()
    const state = sampleState()
    const writer = new IndexedDbWalletStateStore(name)
    await writer.save(state)
    await writer.close()

    const reader = new IndexedDbWalletStateStore(name)
    expect(await reader.load(state.address)).toEqual(state)
    await reader.close()

    const raw = await openRaw(name)
    await new Promise<void>((resolve, reject) => {
      const transaction = raw.transaction('wallet', 'readwrite')
      transaction.objectStore('wallet').put({ address: 'broken', version: 9 })
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    raw.close()
    await expect(reader.load('broken')).rejects.toThrow(/damaged/)
    await reader.close()
  })

  it('backs a DeviceWallet across restarts', async () => {
    const name = freshDbName()
    const chain = new FakeChain()
    const wif = DeviceWallet.generateWif()
    const store = new IndexedDbWalletStateStore(name)
    const wallet = DeviceWallet.fromWif(wif, chain, store)
    chain.fund(wallet.address, 5000, { confirmed: true })
    await wallet.refresh()
    const pending = await wallet.prepareRecords([{ kind: 'E', payload: Uint8Array.of(1, 2, 3) }], fakeAddress(), ['e1'])
    await store.close()

    const restarted = DeviceWallet.fromWif(wif, chain, new IndexedDbWalletStateStore(name))
    expect((await restarted.pending()).map((tx) => tx.txid)).toEqual([pending.txid])
    expect((await restarted.flush()).broadcast).toEqual([pending.txid])
    expect(await restarted.balance()).toMatchObject({ pendingBroadcasts: 0, spendable: expect.any(Number) })
  })
})
