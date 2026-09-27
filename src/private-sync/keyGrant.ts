import { canonicalize } from '../distributed/canonical'
import type { ArgusIdentityProvider } from '../identity/identity'
import type { KeyGrantRecord } from './types'

const HKDF_INFO = new TextEncoder().encode('ARGUS_KEY_GRANT_WRAP_v1')

function base64url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
function fromBase64url(value: string) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

/** A fresh, non-extractable ECDH P-256 keypair. Independent of any ECDSA signing identity: WebCrypto ties a
 * CryptoKey's algorithm to how it was generated/imported, so a device's ECDSA signing key cannot be reused
 * for key agreement. */
export async function generateEcdhKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']) as Promise<CryptoKeyPair>
}

async function deriveWrappingKey(privateKey: CryptoKey, peerPublicKey: CryptoKey): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerPublicKey }, privateKey, 256)
  const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: HKDF_INFO },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  )
}

export type UnsignedKeyGrant = Omit<KeyGrantRecord, 'signature'>

/**
 * Wraps the epoch key CryptoKey (crypto.subtle.wrapKey: extractable required on the source key,
 * but the raw bytes are never exposed to JS) under a key derived by HKDF from the grantor/grantee
 * ECDH shared secret, and signs the result.
 */
export async function wrapEpochKeyForGrant(args: {
  epochKey: CryptoKey
  organizationId: string
  epochId: string
  granteePublicIdentity: string
  grantorPublicIdentity: string
  grantorEcdhPrivateKey: CryptoKey
  granteeEcdhPublicKey: CryptoKey
  grantorSigner: ArgusIdentityProvider
}): Promise<KeyGrantRecord> {
  const wrappingKey = await deriveWrappingKey(args.grantorEcdhPrivateKey, args.granteeEcdhPublicKey)
  const nonceBytes = crypto.getRandomValues(new Uint8Array(12))
  const wrapped = await crypto.subtle.wrapKey('raw', args.epochKey, wrappingKey, { name: 'AES-GCM', iv: nonceBytes })
  const unsigned: UnsignedKeyGrant = {
    protocol: 'ARGUS_KEY_GRANT',
    protocolVersion: 1,
    organizationId: args.organizationId,
    epochId: args.epochId,
    granteePublicIdentity: args.granteePublicIdentity,
    grantorPublicIdentity: args.grantorPublicIdentity,
    wrappedKey: base64url(new Uint8Array(wrapped)),
    nonce: base64url(nonceBytes),
  }
  return { ...unsigned, signature: await args.grantorSigner.sign(canonicalize(unsigned)) }
}

/** Inverse of wrapEpochKeyForGrant. Throws (AES-GCM authentication failure) when the grant was not wrapped to this keypair. */
export async function unwrapEpochKeyFromGrant(grant: KeyGrantRecord, args: {
  granteeEcdhPrivateKey: CryptoKey
  grantorEcdhPublicKey: CryptoKey
  extractable?: boolean
}): Promise<CryptoKey> {
  const wrappingKey = await deriveWrappingKey(args.granteeEcdhPrivateKey, args.grantorEcdhPublicKey)
  return crypto.subtle.unwrapKey(
    'raw',
    fromBase64url(grant.wrappedKey),
    wrappingKey,
    { name: 'AES-GCM', iv: fromBase64url(grant.nonce) },
    { name: 'AES-GCM', length: 256 },
    args.extractable ?? false,
    ['encrypt', 'decrypt'],
  )
}

export function unsignedKeyGrantFields(grant: KeyGrantRecord): UnsignedKeyGrant {
  const unsigned: Partial<KeyGrantRecord> = { ...grant }
  delete unsigned.signature
  return unsigned as UnsignedKeyGrant
}
