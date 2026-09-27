import { describe, expect, it } from 'vitest'
import { decodeCredentialCode, decodeIdentityCode, encodeCredentialCode, encodeIdentityCode } from './codes'
import type { AuthorityCredential } from '../distributed/types'

describe('compact identity codes', () => {
  it('round-trips a public identity through a copyable code', async () => {
    const code = await encodeIdentityCode('p256:abc123')
    expect(code).toMatch(/^ARGUS-IDENTITY-1:/)
    expect(await decodeIdentityCode(code)).toBe('p256:abc123')
  })

  it('refuses a tampered identity code', async () => {
    const code = await encodeIdentityCode('p256:abc123')
    const tampered = `${code.slice(0, -1)}${code.at(-1) === '0' ? '1' : '0'}`
    await expect(decodeIdentityCode(tampered)).rejects.toThrow('damaged')
  })

  it('refuses text that is not an identity code', async () => {
    await expect(decodeIdentityCode('not a code')).rejects.toThrow('not a valid identity code')
  })
})

describe('compact credential codes', () => {
  const credential: AuthorityCredential = {
    credentialVersion: 1,
    credentialId: 'cred-1',
    subjectPublicIdentity: 'p256:subject',
    role: 'SUPPLY_OFFICER',
    permissions: ['inventory.read'],
    issuedAt: '2026-09-27T00:00:00.000Z',
    issuedBy: 'p256:master',
    signature: 'p256sig:deadbeef',
  }

  it('round-trips a credential, its issuer, and its signature through a copyable code', async () => {
    const code = await encodeCredentialCode(credential)
    expect(code).toMatch(/^ARGUS-CREDENTIAL-1:/)
    expect(await decodeCredentialCode(code)).toEqual(credential)
  })

  it('refuses a tampered credential code', async () => {
    const code = await encodeCredentialCode(credential)
    const tampered = `${code.slice(0, -1)}${code.at(-1) === '0' ? '1' : '0'}`
    await expect(decodeCredentialCode(tampered)).rejects.toThrow('damaged')
  })
})
