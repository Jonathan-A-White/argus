import { describe, expect, it } from 'vitest'
import { AuthorizationService, ROLE_PERMISSIONS, issueCredential } from '../auth/authorization'
import { encodeCredentialCode, encodeIdentityCode } from './codes'
import { WebCryptoIdentityProvider } from './identity'
import {
  DEVICE_IDENTITY_STORAGE_KEY,
  admitDeviceWithCredential,
  admitPerson,
  createJoiningDeviceIdentity,
  createMasterDeviceIdentity,
  knownPeople,
  loadDeviceIdentityRecord,
  unlockDeviceIdentity,
} from './deviceIdentity'

const fakeStorage = () => {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
}

describe('device identity persistence', () => {
  it('creates a Master identity, its self-issued MASTER credential, and unlocks a working signer', async () => {
    const storage = fakeStorage()
    const record = await createMasterDeviceIdentity('correct horse battery 7', storage)
    expect(record.role).toBe('MASTER')
    expect(record.authorityCredential?.role).toBe('MASTER')
    expect(loadDeviceIdentityRecord(storage)).toEqual(record)

    const unlocked = await unlockDeviceIdentity(record, 'correct horse battery 7')
    expect(unlocked.role).toBe('MASTER')
    expect(unlocked.publicIdentity).toBe(record.applicationCredential.publicIdentity)
    expect(unlocked.authorization).toBeInstanceOf(AuthorizationService)
    expect(() => unlocked.authorization!.require(unlocked.publicIdentity, 'users.authorize')).not.toThrow()
  })

  it('never stores unwrapped application or authority key material', async () => {
    const storage = fakeStorage()
    await createMasterDeviceIdentity('correct horse battery 7', storage)
    const raw = storage.getItem(DEVICE_IDENTITY_STORAGE_KEY)!

    // A test-only exportable twin stands in for what raw key bytes would look like if ever exported.
    const twin = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const twinJwk = (await crypto.subtle.exportKey('jwk', twin.privateKey)) as JsonWebKey
    expect(raw).not.toContain(twinJwk.d!)

    const record = JSON.parse(raw) as { applicationCredential: { encryptedPrivateJwk: string }; authorityKey: { encryptedPrivateJwk: string } }
    expect(record.applicationCredential.encryptedPrivateJwk).not.toBe(record.authorityKey.encryptedPrivateJwk)
    const decodeBase64url = (value: string) => atob(value.replaceAll('-', '+').replaceAll('_', '/').padEnd(value.length + ((4 - (value.length % 4)) % 4), '='))
    expect(() => JSON.parse(decodeBase64url(record.applicationCredential.encryptedPrivateJwk))).toThrow()
    expect(() => JSON.parse(decodeBase64url(record.authorityKey.encryptedPrivateJwk))).toThrow()
  })

  it('creates a joining device with only an application key and no authority credential', async () => {
    const storage = fakeStorage()
    const record = await createJoiningDeviceIdentity('correct horse battery 7', storage)
    expect(record.role).toBe('PENDING')
    expect(record.authorityCredential).toBeUndefined()
    expect(record.authorityKey).toBeUndefined()
    const unlocked = await unlockDeviceIdentity(record, 'correct horse battery 7')
    expect(unlocked.role).toBe('PENDING')
    expect(unlocked.authorization).toBeUndefined()
  })

  it('rejects a self-issued credential from a different, unrelated authority key', async () => {
    const storage = fakeStorage()
    const record = await createMasterDeviceIdentity('correct horse battery 7', storage)
    const unlocked = await unlockDeviceIdentity(record, 'correct horse battery 7')
    const authorization = unlocked.authorization!

    const impostorAuthority = await WebCryptoIdentityProvider.create()
    const impostorCredential = await issueCredential(impostorAuthority, {
      subjectPublicIdentity: unlocked.publicIdentity,
      role: 'MASTER',
      permissions: [...ROLE_PERMISSIONS.MASTER],
      issuedAt: new Date().toISOString(),
    })
    await expect(authorization.acceptCredential(impostorCredential)).rejects.toThrow('Credential issuer is not authorized.')
  })

  it('refuses the wrong passphrase and returns undefined for a missing record', async () => {
    const storage = fakeStorage()
    expect(loadDeviceIdentityRecord(storage)).toBeUndefined()
    const record = await createMasterDeviceIdentity('correct horse battery 7', storage)
    await expect(unlockDeviceIdentity(record, 'wrong passphrase 7')).rejects.toThrow('incorrect or')
  })

  it('unlocks a Master device with a usable authority signer for admitting people', async () => {
    const storage = fakeStorage()
    const record = await createMasterDeviceIdentity('correct horse battery 7', storage)
    const unlocked = await unlockDeviceIdentity(record, 'correct horse battery 7')
    expect(unlocked.authoritySigner).toBeDefined()
    expect(await unlocked.authoritySigner!.getPublicIdentity()).toBe(record.authorityKey!.publicIdentity)
  })
})

describe('admission', () => {
  const password = 'correct horse battery 7'

  it('admits a joining device with a role, and the joining device unlocks into that role after pasting the credential', async () => {
    const masterStorage = fakeStorage()
    const masterRecord = await createMasterDeviceIdentity(password, masterStorage)
    const master = await unlockDeviceIdentity(masterRecord, password)

    const joiningStorage = fakeStorage()
    const joiningRecord = await createJoiningDeviceIdentity(password, joiningStorage)
    const joining = await unlockDeviceIdentity(joiningRecord, password)
    const identityCode = await encodeIdentityCode(joining.publicIdentity)

    const admitted = await admitPerson(masterRecord, master.authoritySigner!, identityCode, 'SUPPLY_OFFICER', undefined, masterStorage)
    expect(knownPeople(admitted.record)).toEqual([
      expect.objectContaining({ publicIdentity: master.publicIdentity, role: 'MASTER', you: true }),
      expect.objectContaining({ publicIdentity: joining.publicIdentity, role: 'SUPPLY_OFFICER', you: false }),
    ])

    const { record: updatedJoiningRecord, authorization } = await admitDeviceWithCredential(joiningRecord, joining.identity, admitted.credentialCode, joiningStorage)
    expect(updatedJoiningRecord.role).toBe('SUPPLY_OFFICER')
    expect(updatedJoiningRecord.pinnedAuthority).toBe(await master.authoritySigner!.getPublicIdentity())
    expect(() => authorization.require(joining.publicIdentity, 'inventory.issue')).not.toThrow()

    const rehydrated = await unlockDeviceIdentity(updatedJoiningRecord, password)
    expect(rehydrated.role).toBe('SUPPLY_OFFICER')
    expect(knownPeople(updatedJoiningRecord)).toEqual([
      expect.objectContaining({ publicIdentity: joining.publicIdentity, role: 'SUPPLY_OFFICER', you: true }),
      expect.objectContaining({ publicIdentity: await master.authoritySigner!.getPublicIdentity(), role: 'MASTER', you: false }),
    ])
  })

  it('refuses a credential signed by a different, unrelated authority key', async () => {
    const joiningStorage = fakeStorage()
    const joiningRecord = await createJoiningDeviceIdentity(password, joiningStorage)
    const joining = await unlockDeviceIdentity(joiningRecord, password)

    const impostorAuthority = await WebCryptoIdentityProvider.create()
    const forgedCredential = await issueCredential(impostorAuthority, {
      subjectPublicIdentity: joining.publicIdentity,
      role: 'SUPPLY_OFFICER',
      permissions: [...ROLE_PERMISSIONS.SUPPLY_OFFICER],
      issuedAt: new Date().toISOString(),
    })
    const forgedCode = await encodeCredentialCode({ ...forgedCredential, issuedBy: 'p256:someone-else' })

    await expect(admitDeviceWithCredential(joiningRecord, joining.identity, forgedCode, joiningStorage)).rejects.toThrow('Invalid credential signature.')
  })

  it('pins the admitting Master as this device\'s root, and refuses a later valid credential from a different root naming the mismatch', async () => {
    const masterAStorage = fakeStorage()
    const masterARecord = await createMasterDeviceIdentity(password, masterAStorage)
    const masterA = await unlockDeviceIdentity(masterARecord, password)

    const masterBStorage = fakeStorage()
    const masterBRecord = await createMasterDeviceIdentity(password, masterBStorage)
    const masterB = await unlockDeviceIdentity(masterBRecord, password)

    const joiningStorage = fakeStorage()
    const joiningRecord = await createJoiningDeviceIdentity(password, joiningStorage)
    const joining = await unlockDeviceIdentity(joiningRecord, password)
    const identityCode = await encodeIdentityCode(joining.publicIdentity)

    const admittedByA = await admitPerson(masterARecord, masterA.authoritySigner!, identityCode, 'INSTRUCTOR', undefined, masterAStorage)
    const { record: pinnedRecord } = await admitDeviceWithCredential(joiningRecord, joining.identity, admittedByA.credentialCode, joiningStorage)
    expect(pinnedRecord.pinnedAuthority).toBe(await masterA.authoritySigner!.getPublicIdentity())

    const admittedByB = await admitPerson(masterBRecord, masterB.authoritySigner!, identityCode, 'INSTRUCTOR', undefined, masterBStorage)
    await expect(admitDeviceWithCredential(pinnedRecord, joining.identity, admittedByB.credentialCode, joiningStorage)).rejects.toThrow(await masterA.authoritySigner!.getPublicIdentity())
  })

  it('refuses a tampered credential code', async () => {
    const masterStorage = fakeStorage()
    const masterRecord = await createMasterDeviceIdentity(password, masterStorage)
    const master = await unlockDeviceIdentity(masterRecord, password)
    const joiningStorage = fakeStorage()
    const joiningRecord = await createJoiningDeviceIdentity(password, joiningStorage)
    const joining = await unlockDeviceIdentity(joiningRecord, password)
    const identityCode = await encodeIdentityCode(joining.publicIdentity)

    const admitted = await admitPerson(masterRecord, master.authoritySigner!, identityCode, 'SUPPLY_ASSISTANT', undefined, masterStorage)
    const tampered = `${admitted.credentialCode.slice(0, -1)}${admitted.credentialCode.at(-1) === '0' ? '1' : '0'}`
    await expect(admitDeviceWithCredential(joiningRecord, joining.identity, tampered, joiningStorage)).rejects.toThrow('damaged')
  })
})
