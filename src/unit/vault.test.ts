import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { AuthorizationService } from '../auth/authorization'
import { DEFAULT_WALLET_DB_NAME, IndexedDbWalletStateStore } from '../chain/walletStore'
import { IndexedDbLedgerStore } from './ledgerStore'
import type { SignedArgusEvent } from '../distributed/types'
import { canonicalize } from '../distributed/canonical'
import { PUBLIC_ENVELOPE_FIELDS, deserializeEnvelope, openEnvelope, sealEnvelope, serializeEnvelope } from './envelope'
import { DEVICE_VAULT_STORAGE_KEY, acceptAdmission, admitMember, createJoiningDevice, createMasterDevice, decodeJoinRequest, encodeJoinRequest, forgetDevice, loadDeviceVault, unlockDevice } from './vault'

const memoryStorage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) }, values } }
const PASS = 'supply closet 42'

async function signedEvent(device: Awaited<ReturnType<typeof createMasterDevice>>, payload: Record<string, unknown>): Promise<SignedArgusEvent> {
  const event = { protocol: 'ARGUS' as const, protocolVersion: 1 as const, organizationId: device.record.unit!.unitId, eventVersion: 1 as const, eventId: crypto.randomUUID(), eventType: 'CADET_CREATED' as const, entityId: 'cadet_x', actorPublicIdentity: device.record.signingIdentity, timestamp: '2026-09-27T12:00:00.000Z', clock: 1, payload }
  return { ...event, signature: await device.identity.sign(canonicalize(event)) }
}

describe('device vault and admission', { timeout: 60_000 }, () => {
  it('creates a Master device holding its own keys, a unit, and a self-issued MASTER credential — all sealed under one passphrase', async () => {
    const storage = memoryStorage()
    const master = await createMasterDevice({ passphrase: PASS, displayName: 'Luke', unitName: 'Bethel NJROTC' }, storage)
    expect(master.record.role).toBe('MASTER')
    expect(master.record.unit).toMatchObject({ unitName: 'Bethel NJROTC', currentEpoch: 'e1', epochs: ['e1'] })
    expect(master.record.walletAddress).toMatch(/^[mn]/)
    expect(master.unitKeys.get('e1')).toBeDefined()
    const stored = storage.values.get(DEVICE_VAULT_STORAGE_KEY)!
    // No WIF, JWK private component or raw unit key is ever stored in the clear.
    expect(stored).not.toContain(master.walletWif)
    expect(stored).not.toMatch(/"d":"/)
    await expect(unlockDevice(loadDeviceVault(storage)!, 'wrong passphrase 1')).rejects.toThrow(/not correct/)
    const again = await unlockDevice(loadDeviceVault(storage)!, PASS)
    expect(again.walletWif).toBe(master.walletWif)
    expect(await again.identity.getPublicIdentity()).toBe(master.record.signingIdentity)
  })

  it('admits a second person by exchanging public codes only, after which both devices can read each other’s encrypted events', async () => {
    const masterStorage = memoryStorage(), joinerStorage = memoryStorage()
    const master = await createMasterDevice({ passphrase: PASS, displayName: 'Luke', unitName: 'Bethel NJROTC' }, masterStorage)
    const joiner = await createJoiningDevice({ passphrase: 'another pass 77', displayName: 'Jordan' }, joinerStorage)
    expect(joiner.record.role).toBe('PENDING')
    const joinCode = await encodeJoinRequest(joiner)
    expect(await decodeJoinRequest(joinCode)).toMatchObject({ name: 'Jordan', wallet: joiner.record.walletAddress })
    const { admissionCode, credential } = await admitMember(master, joinCode, 'SUPPLY_OFFICER', { storage: masterStorage })
    expect(admissionCode).not.toContain(joiner.walletWif)
    const admitted = await acceptAdmission(joiner, admissionCode, joinerStorage)
    expect(admitted.record).toMatchObject({ role: 'SUPPLY_OFFICER', unit: { unitId: master.record.unit!.unitId, currentEpoch: 'e1' } })
    // The admitted device's credential chains to the unit authority.
    const authorization = new AuthorizationService(master.record.unit!.authorityIdentity, admitted.identity)
    await authorization.acceptCredential(credential)
    expect(() => authorization.require(admitted.record.signingIdentity, 'inventory.count')).not.toThrow()
    // Survives a restart: unlock from storage and read the Master's encrypted event.
    const reopened = await unlockDevice(loadDeviceVault(joinerStorage)!, 'another pass 77')
    const event = await signedEvent(master, { fullName: 'Private Cadet Name', gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE', sizes: {}, cadetCode: 'C-7K2Q' })
    const envelope = await sealEnvelope({ unitId: master.record.unit!.unitId, epochId: 'e1', key: master.unitKeys.get('e1')!, plaintext: { event, credential: master.record.credential } })
    const opened = await openEnvelope(deserializeEnvelope(serializeEnvelope(envelope)), async epoch => reopened.unitKeys.get(epoch))
    expect(opened.event).toEqual(event)
    expect(opened.credential).toEqual(master.record.credential)
  })

  it('refuses admission codes meant for another device or signed by a different unit', async () => {
    const master = await createMasterDevice({ passphrase: PASS, displayName: 'Luke', unitName: 'Unit A' }, memoryStorage())
    const other = await createMasterDevice({ passphrase: PASS, displayName: 'Mallory', unitName: 'Unit B' }, memoryStorage())
    const alice = await createJoiningDevice({ passphrase: PASS, displayName: 'Alice' }, memoryStorage())
    const bob = await createJoiningDevice({ passphrase: PASS, displayName: 'Bob' }, memoryStorage())
    const forAlice = await admitMember(master, await encodeJoinRequest(alice), 'SUPPLY_ASSISTANT', { storage: memoryStorage() })
    await expect(acceptAdmission(bob, forAlice.admissionCode, memoryStorage())).rejects.toThrow(/different device/)
    const joined = await acceptAdmission(alice, forAlice.admissionCode, memoryStorage())
    const fromOther = await admitMember(other, await encodeJoinRequest(alice), 'SUPPLY_ASSISTANT', { storage: memoryStorage() })
    await expect(acceptAdmission(joined, fromOther.admissionCode, memoryStorage())).rejects.toThrow(/different unit/)
    await expect(admitMember(joined, await encodeJoinRequest(bob), 'SUPPLY_ASSISTANT')).rejects.toThrow(/Only a unit Master/)
  })
})

describe('encrypted envelope', { timeout: 60_000 }, () => {
  it('puts nothing but the declared public fields on chain; names, actor and event type stay inside ciphertext', async () => {
    const master = await createMasterDevice({ passphrase: PASS, displayName: 'Luke', unitName: 'Bethel NJROTC' }, memoryStorage())
    const event = await signedEvent(master, { fullName: 'Private Cadet Name', gender: 'Female', nsLevel: 'NS2', status: 'ACTIVE', sizes: { 'PT Shorts': 'M' }, cadetCode: 'C-7K2Q' })
    const envelope = await sealEnvelope({ unitId: master.record.unit!.unitId, epochId: 'e1', key: master.unitKeys.get('e1')!, plaintext: { event } })
    const onChain = new TextDecoder().decode(serializeEnvelope(envelope))
    expect(Object.keys(JSON.parse(onChain)).sort()).toEqual([...PUBLIC_ENVELOPE_FIELDS].sort())
    for (const secret of ['Private Cadet Name', 'CADET_CREATED', 'C-7K2Q', master.record.signingIdentity, 'Female', 'PT Shorts', '2026-09-27']) expect(onChain).not.toContain(secret)
    // Tampering with the public header or ciphertext is detected.
    await expect(openEnvelope({ ...envelope, eventId: crypto.randomUUID() }, async () => master.unitKeys.get('e1'))).rejects.toThrow(/authentication failed/)
    await expect(openEnvelope({ ...envelope, epoch: 'e2' }, async () => undefined)).rejects.toThrow(/NO_EPOCH_KEY/)
    const other = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    await expect(openEnvelope(envelope, async () => other)).rejects.toThrow(/authentication failed/)
  })

  it('"Erase this device" also deletes the local ledger and wallet databases (minor 9)', async () => {
    const storage = memoryStorage(), factory = new IDBFactory()
    const master = await createMasterDevice({ passphrase: PASS, displayName: 'Luke', unitName: 'Bethel NJROTC' }, storage)
    const unitId = master.record.unit!.unitId
    // Open connections, as a device that was just locked still has them.
    const ledger = new IndexedDbLedgerStore(unitId, factory)
    await ledger.addEnvelope({ eventId: 'a', envelope: { v: 2, unit: unitId, epoch: 'e1', eventId: 'a', z: 0, nonce: 'bm9uY2U=', ct: 'Y2lwaGVy' }, origin: 'local', status: 'QUEUED', addedAt: '2026-09-27T00:00:00.000Z' })
    await new IndexedDbWalletStateStore(DEFAULT_WALLET_DB_NAME, factory).save({ version: 1, address: master.record.walletAddress, coins: [], pending: [], recent: [] } as never)
    const names = async () => (await factory.databases()).map(database => database.name).sort()
    expect(await names()).toEqual([DEFAULT_WALLET_DB_NAME, IndexedDbLedgerStore.databaseName(unitId)].sort())

    await forgetDevice(storage, factory)
    expect(storage.values.has(DEVICE_VAULT_STORAGE_KEY)).toBe(false)
    expect(await names()).toEqual([])
    // Nothing of the erased unit comes back when a store is opened again.
    expect(await new IndexedDbLedgerStore(unitId, factory).envelopes()).toEqual([])
  })
})
