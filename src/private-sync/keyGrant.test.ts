import { describe, expect, it } from 'vitest'
import { canonicalize } from '../distributed/canonical'
import { MockIdentityProvider } from '../identity/identity'
import { generateEcdhKeyPair, unsignedKeyGrantFields, unwrapEpochKeyFromGrant, wrapEpochKeyForGrant } from './keyGrant'

async function grantFixture() {
  const master = new MockIdentityProvider('master'), device = new MockIdentityProvider('device'), third = new MockIdentityProvider('third')
  const masterEcdh = await generateEcdhKeyPair(), deviceEcdh = await generateEcdhKeyPair(), thirdEcdh = await generateEcdhKeyPair()
  const epochKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  const grant = await wrapEpochKeyForGrant({
    epochKey,
    organizationId: 'org-key-grant',
    epochId: 'epoch-001',
    granteePublicIdentity: await device.getPublicIdentity(),
    grantorPublicIdentity: await master.getPublicIdentity(),
    grantorEcdhPrivateKey: masterEcdh.privateKey,
    granteeEcdhPublicKey: deviceEcdh.publicKey,
    grantorSigner: master,
  })
  return { master, device, third, masterEcdh, deviceEcdh, thirdEcdh, epochKey, grant }
}

async function encryptedProbe(key: CryptoKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('epoch key probe'))
  return { iv, ciphertext }
}

describe('key grant wrapping (real WebCrypto ECDH + HKDF + AES-GCM key wrap, no mocks)', () => {
  it('wraps an epoch key from a Master identity to a device identity, and the device unwraps the exact key', async () => {
    const { deviceEcdh, masterEcdh, epochKey, grant } = await grantFixture()
    const unwrapped = await unwrapEpochKeyFromGrant(grant, { granteeEcdhPrivateKey: deviceEcdh.privateKey, grantorEcdhPublicKey: masterEcdh.publicKey })
    expect(unwrapped.algorithm).toEqual({ name: 'AES-GCM', length: 256 })
    expect(unwrapped.extractable).toBe(false)
    const { iv, ciphertext } = await encryptedProbe(epochKey)
    expect(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, unwrapped, ciphertext))).toBe('epoch key probe')
  })

  it('a third identity, not addressed by the grant, cannot unwrap it', async () => {
    const { thirdEcdh, masterEcdh, grant } = await grantFixture()
    await expect(unwrapEpochKeyFromGrant(grant, { granteeEcdhPrivateKey: thirdEcdh.privateKey, grantorEcdhPublicKey: masterEcdh.publicKey })).rejects.toThrow()
  })

  it('signs the grant so tampering with any signed field invalidates the grantor signature', async () => {
    const { master, grant } = await grantFixture()
    expect(await master.verify(canonicalize(unsignedKeyGrantFields(grant)), grant.signature, await master.getPublicIdentity())).toBe(true)
    const tampered = { ...grant, wrappedKey: `${grant.wrappedKey.slice(0, -2)}AA` }
    expect(await master.verify(canonicalize(unsignedKeyGrantFields(tampered)), tampered.signature, await master.getPublicIdentity())).toBe(false)
  })
})
