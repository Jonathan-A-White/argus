import { describe, expect, it } from 'vitest'
import { AuthorizationService, ROLE_PERMISSIONS, issueCredential } from '../auth/authorization'
import { WebCryptoIdentityProvider } from './identity'
import {
  DEVICE_IDENTITY_STORAGE_KEY,
  createJoiningDeviceIdentity,
  createMasterDeviceIdentity,
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
})
