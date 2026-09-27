import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { canonicalize } from '../distributed/canonical'
import { MockIdentityProvider } from '../identity/identity'
import type { SignedArgusEvent } from '../distributed/types'
import { ChainKeyDistribution } from './ChainKeyDistribution'
import { decryptEvent, encryptEvent } from './crypto'
import { DurableEncryptedEventSyncProvider } from './eventSyncProvider'
import { generateEcdhKeyPair, wrapEpochKeyForGrant } from './keyGrant'
import { MockPrivateHistoryProvider } from './provider'
import { KEY_GRANT_RECORD_FIELDS, parseKeyGrantRecord } from './schema'
import { MemoryRepository } from '../storage/repository'
import type { EcdhKeyDirectory, KeyGrantChainProvider, KeyGrantPage, KeyGrantRecord } from './types'

const organizationId = 'org-chain-keys'

function stubKeyGrantProvider(): KeyGrantChainProvider & { records: KeyGrantRecord[] } {
  const records: KeyGrantRecord[] = []
  return {
    records,
    async publishKeyGrant(record) { records.push(parseKeyGrantRecord(record)) },
    async getKeyGrantsSince(cursor = '0'): Promise<KeyGrantPage> {
      const from = Number(cursor)
      return { records: records.slice(from), cursor: String(records.length) }
    },
  }
}

async function makeDevice(label: string) {
  const identity = new MockIdentityProvider(label)
  return { identity, publicIdentity: await identity.getPublicIdentity(), ecdh: await generateEcdhKeyPair() }
}
type Device = Awaited<ReturnType<typeof makeDevice>>

function directoryOver(devices: Device[]): EcdhKeyDirectory {
  return {
    async publicKeyFor(identity) {
      const device = devices.find(candidate => candidate.publicIdentity === identity)
      if (!device) throw new Error(`No ECDH public key known for ${identity}.`)
      return device.ecdh.publicKey
    },
  }
}

/** A Master and two devices sharing one in-memory key-grant chain and ECDH directory. */
async function orgFixture(dbSuffix: string) {
  const master = await makeDevice('master'), deviceA = await makeDevice('device-a'), deviceB = await makeDevice('device-b')
  const provider = stubKeyGrantProvider()
  const directory = directoryOver([master, deviceA, deviceB])
  const keysFor = (device: Device, asMaster: boolean) =>
    new ChainKeyDistribution(organizationId, master.publicIdentity, device.publicIdentity, device.ecdh, device.identity, directory, provider, asMaster ? device.identity : undefined, { dbName: `chain-keys-test-${dbSuffix}` })
  return { master, deviceA, deviceB, provider, directory, masterKeys: keysFor(master, true), deviceAKeys: keysFor(deviceA, false), deviceBKeys: keysFor(deviceB, false) }
}

async function signedEvent(eventId: string, actor: MockIdentityProvider): Promise<SignedArgusEvent> {
  const unsigned = { protocol: 'ARGUS' as const, protocolVersion: 1 as const, organizationId, eventVersion: 1 as const, eventId, eventType: 'ITEM_ISSUED' as const, entityId: 'item-a', actorPublicIdentity: await actor.getPublicIdentity(), timestamp: '2026-09-27T00:00:00.000Z', baseVersion: 0, payload: { quantity: 1 } }
  return { ...unsigned, signature: await actor.sign(canonicalize(unsigned)) }
}

describe('ChainKeyDistribution', () => {
  it('throws before any epoch has been rotated', async () => {
    const { masterKeys } = await orgFixture('no-epoch')
    expect(() => masterKeys.currentEpoch()).toThrow(/No encryption epoch/)
  })

  it('rotates an epoch: the Master and an authorized device can both use the resulting key; an unauthorized device is denied with NO_EPOCH_KEY', async () => {
    const { master, deviceA, deviceB, masterKeys, deviceAKeys, deviceBKeys } = await orgFixture('rotate')
    const epochId = await masterKeys.rotateEpoch([master.publicIdentity, deviceA.publicIdentity])
    expect(masterKeys.currentEpoch()).toBe(epochId)

    const event = await signedEvent('event-1', master.identity)
    const envelope = await encryptEvent(event, master.identity, masterKeys)
    expect(await decryptEvent(envelope, deviceA.publicIdentity, deviceA.identity, deviceAKeys)).toEqual(event)

    await expect(deviceBKeys.keyFor(deviceB.publicIdentity, epochId)).rejects.toThrow(/NO_EPOCH_KEY/)
  })

  it('AC5: a key grant record carries only its protocol fields; no name, role, or other personal data', async () => {
    const { master, deviceA, provider } = await orgFixture('fields')
    const masterKeys = new ChainKeyDistribution(organizationId, master.publicIdentity, master.publicIdentity, master.ecdh, master.identity, directoryOver([master, deviceA]), provider, master.identity, { dbName: 'chain-keys-test-fields' })
    await masterKeys.rotateEpoch([master.publicIdentity, deviceA.publicIdentity])
    expect(provider.records.length).toBeGreaterThan(0)
    for (const record of provider.records) expect(Object.keys(record).sort()).toEqual([...KEY_GRANT_RECORD_FIELDS].sort())
  })

  it('AC4: a grant whose grantor is not the pinned Master is ignored', async () => {
    const { deviceA, deviceAKeys, provider } = await orgFixture('unpinned')
    await deviceAKeys.sync() // establishes the empty baseline before the forged record is added
    const impostor = new MockIdentityProvider('impostor')
    const impostorEcdh = await generateEcdhKeyPair()
    const forged = await wrapEpochKeyForGrant({
      epochKey: await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']),
      organizationId,
      epochId: 'epoch-999',
      granteePublicIdentity: deviceA.publicIdentity,
      grantorPublicIdentity: await impostor.getPublicIdentity(),
      grantorEcdhPrivateKey: impostorEcdh.privateKey,
      granteeEcdhPublicKey: deviceA.ecdh.publicKey,
      grantorSigner: impostor,
    })
    await provider.publishKeyGrant(forged)
    await expect(deviceAKeys.keyFor(deviceA.publicIdentity, 'epoch-999')).rejects.toThrow(/NO_EPOCH_KEY/)
  })

  it('AC3: after revoke(deviceB), a new-epoch event decrypts on device A and is quarantined as NO_EPOCH_KEY (not thrown) on device B; the old epoch still decrypts on B', async () => {
    const { master, deviceA, deviceB, masterKeys, deviceAKeys, deviceBKeys } = await orgFixture('revoke')
    const oldEpoch = await masterKeys.rotateEpoch([master.publicIdentity, deviceA.publicIdentity, deviceB.publicIdentity])
    const oldEvent = await signedEvent('event-old', master.identity)
    const oldEnvelope = await encryptEvent(oldEvent, master.identity, masterKeys)
    expect(await decryptEvent(oldEnvelope, deviceB.publicIdentity, deviceB.identity, deviceBKeys)).toEqual(oldEvent)

    masterKeys.revoke(deviceB.publicIdentity)
    await masterKeys.flush()
    expect(masterKeys.currentEpoch()).not.toBe(oldEpoch)

    const eventsTransport = new MockPrivateHistoryProvider('events')
    const newEvent = await signedEvent('event-new', master.identity)
    await eventsTransport.publish(await encryptEvent(newEvent, master.identity, masterKeys))

    const repositoryA = new MemoryRepository()
    const syncA = new DurableEncryptedEventSyncProvider('a', repositoryA, eventsTransport, deviceA.identity, deviceAKeys, organizationId)
    const pulledA = await syncA.pull()
    expect(pulledA.map(event => event.eventId)).toContain('event-new')
    expect((await repositoryA.snapshot()).quarantine).toEqual([])

    const repositoryB = new MemoryRepository()
    const syncB = new DurableEncryptedEventSyncProvider('b', repositoryB, eventsTransport, deviceB.identity, deviceBKeys, organizationId)
    const pulledB = await syncB.pull()
    expect(pulledB.map(event => event.eventId)).toEqual([])
    const quarantineB = (await repositoryB.snapshot()).quarantine
    expect(quarantineB).toHaveLength(1)
    expect(quarantineB[0].reason).toMatch(/NO_EPOCH_KEY/)

    expect(await decryptEvent(oldEnvelope, deviceB.publicIdentity, deviceB.identity, deviceBKeys)).toEqual(oldEvent)
  })

  it('grantHistory publishes past epoch grants to a newly admitted device', async () => {
    const { master, deviceA, masterKeys, deviceAKeys } = await orgFixture('grant-history')
    const epoch1 = await masterKeys.rotateEpoch([master.publicIdentity])
    const oldEvent = await signedEvent('event-history', master.identity)
    const oldEnvelope = await encryptEvent(oldEvent, master.identity, masterKeys)

    masterKeys.grantHistory(deviceA.publicIdentity, [epoch1])
    await masterKeys.flush()

    expect(await decryptEvent(oldEnvelope, deviceA.publicIdentity, deviceA.identity, deviceAKeys)).toEqual(oldEvent)
  })

  it('grantHistory and revoke reject an unknown epoch or a non-Master caller synchronously', async () => {
    const { master, deviceA, masterKeys, deviceAKeys } = await orgFixture('sync-guards')
    await masterKeys.rotateEpoch([master.publicIdentity])
    expect(() => masterKeys.grantHistory(deviceA.publicIdentity, ['epoch-999'])).toThrow(/Unknown encryption epoch/)
    expect(() => deviceAKeys.grantHistory(master.publicIdentity, ['epoch-001'])).toThrow(/Unauthorized/)
    expect(() => deviceAKeys.revoke(master.publicIdentity)).toThrow(/Unauthorized/)
  })
})
