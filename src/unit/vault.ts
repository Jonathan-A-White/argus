import { PrivateKey } from '@bsv/sdk'
import { ROLE_PERMISSIONS, issueCredential } from '../auth/authorization'
import { canonicalize } from '../distributed/canonical'
import type { ArgusRole, AuthorityCredential } from '../distributed/types'
import { decodeCode, encodeCode } from '../identity/codes'
import { WebCryptoIdentityProvider, type ArgusIdentityProvider } from '../identity/identity'
import { unsignedKeyGrantFields, unwrapEpochKeyFromGrant, wrapEpochKeyForGrant } from '../private-sync/keyGrant'
import { parseKeyGrantRecord } from '../private-sync/schema'
import type { KeyGrantRecord } from '../private-sync/types'

/**
 * Device vault (format 2). One passphrase unlocks everything a device holds:
 *   signing   — the person's own ECDSA P-256 key; every event they create is signed with it
 *   ecdh      — ECDH P-256 key the Master uses to hand this device the unit data key
 *   wallet    — this device's own BSV TESTNET key that pays the few satoshis each record costs
 *   authority — MASTER only: the unit authority key that signs member credentials
 *   unitKey:* — the AES-256 unit data key(s) that encrypt everything the unit writes to chain
 * Each secret is AES-256-GCM ciphertext under a key derived from the passphrase
 * (PBKDF2-SHA-256, 600k iterations) with the secret's name as additional data. Nothing here is
 * usable without the passphrase, and nothing secret ever leaves the device: members are admitted
 * by exchanging public codes, never by copying a key.
 */
export const DEVICE_VAULT_STORAGE_KEY = 'argus.device.v2'
const KDF_ITERATIONS = 600_000
export type DeviceRole = ArgusRole | 'PENDING'
export type UnitInfo = { unitId: string; unitName: string; authorityIdentity: string; currentEpoch: string; epochs: string[]; joinedAt: string }
export type AdmissionRecord = { credential: AuthorityCredential; displayName: string; walletAddress?: string; admittedAt: string }
type SealedSecret = { nonce: string; ct: string }
export type DeviceVaultRecord = {
  version: 2
  kdf: { name: 'PBKDF2-SHA-256'; iterations: number; salt: string }
  secrets: Record<string, SealedSecret>
  signingIdentity: string
  ecdhPublicKey: string
  walletAddress: string
  displayName: string
  role: DeviceRole
  unit?: UnitInfo
  credential?: AuthorityCredential
  /** MASTER only: the Master's own credential chain other devices need to trust key grants it signs. */
  admissions?: AdmissionRecord[]
  createdAt: string
}
export type UnlockedDevice = {
  record: DeviceVaultRecord
  identity: ArgusIdentityProvider
  authoritySigner?: ArgusIdentityProvider
  ecdhPrivateKey: CryptoKey
  walletWif: string
  unitKeys: Map<string, CryptoKey>
  /** Kept only in memory while unlocked so an admission can be stored without re-entering the passphrase. */
  vaultKey: CryptoKey
}
export type JoinRequest = { identity: string; ecdh: string; wallet: string; name: string }
export type AdmissionPackage = { unit: Pick<UnitInfo, 'unitId' | 'unitName' | 'authorityIdentity'>; credential: AuthorityCredential; grantor: { identity: string; ecdh: string; credential: AuthorityCredential }; grants: KeyGrantRecord[]; currentEpoch: string }
type Storage2 = Pick<Storage, 'getItem' | 'setItem'>

const encoder = new TextEncoder(), decoder = new TextDecoder()
const b64url = (bytes: Uint8Array) => { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') }
const fromB64url = (value: string) => { const normalized = value.replaceAll('-', '+').replaceAll('_', '/'); return Uint8Array.from(atob(normalized + '='.repeat((4 - normalized.length % 4) % 4)), c => c.charCodeAt(0)) }
const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer
const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('')

export function validatePassphrase(passphrase: string) {
  if (passphrase.length < 12 || !/[a-z]/i.test(passphrase) || !/\d/.test(passphrase)) throw new Error('Use at least 12 characters including a letter and a number.')
}
export function validateDisplayName(name: string) {
  const value = name.trim(); if (!value || value.length > 60) throw new Error('Enter your name or call sign (1–60 characters).'); return value
}
async function deriveVaultKey(passphrase: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey('raw', buffer(encoder.encode(passphrase)), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: buffer(salt), iterations: KDF_ITERATIONS }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
async function seal(key: CryptoKey, name: string, value: string): Promise<SealedSecret> {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: buffer(encoder.encode(name)) }, key, buffer(encoder.encode(value)))
  return { nonce: b64url(nonce), ct: b64url(new Uint8Array(ct)) }
}
async function unseal(key: CryptoKey, name: string, sealed: SealedSecret) {
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buffer(fromB64url(sealed.nonce)), additionalData: buffer(encoder.encode(name)) }, key, buffer(fromB64url(sealed.ct)))
  return decoder.decode(clear)
}
async function newSigningKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair
  return { identity: `p256:${b64url(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)))}`, jwk: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)) }
}
async function importSigner(jwk: string, identity: string) {
  const privateKey = await crypto.subtle.importKey('jwk', JSON.parse(jwk) as JsonWebKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const publicKey = await crypto.subtle.importKey('spki', buffer(fromB64url(identity.slice(5))), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  return WebCryptoIdentityProvider.fromKeyPair({ privateKey, publicKey }, identity)
}
async function newEcdhKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  return { publicKey: b64url(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))), jwk: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)) }
}
const importEcdhPublic = (spki: string) => crypto.subtle.importKey('spki', buffer(fromB64url(spki)), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
const importEcdhPrivate = (jwk: string) => crypto.subtle.importKey('jwk', JSON.parse(jwk) as JsonWebKey, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
/** The Master keeps its unit key extractable only so it can wrap it for new members; members import it non-extractable. */
const importUnitKey = (raw: string, extractable: boolean) => crypto.subtle.importKey('raw', buffer(fromB64url(raw)), { name: 'AES-GCM' }, extractable, ['encrypt', 'decrypt'])
const newWalletWif = () => { const key = PrivateKey.fromRandom(); return { wif: key.toWif([0xef]), address: key.toAddress('testnet') } }
const walletFromWif = (wif: string) => { const key = PrivateKey.fromWif(wif); if (key.toWif([0xef]) !== wif) throw new Error('Only BSV testnet wallet keys are accepted.'); return { wif, address: key.toAddress('testnet') } }
export const epochSecretName = (epochId: string) => `unitKey:${epochId}`

export function loadDeviceVault(storage: Pick<Storage, 'getItem'> = localStorage): DeviceVaultRecord | undefined {
  const raw = storage.getItem(DEVICE_VAULT_STORAGE_KEY); if (!raw) return undefined
  const value = JSON.parse(raw) as Partial<DeviceVaultRecord>
  if (value.version !== 2 || !value.kdf || !value.secrets || !value.signingIdentity || !value.role) throw new Error('The stored A.R.G.U.S. device record is unreadable.')
  return value as DeviceVaultRecord
}
function saveDeviceVault(record: DeviceVaultRecord, storage: Storage2) { storage.setItem(DEVICE_VAULT_STORAGE_KEY, JSON.stringify(record)); return record }

/** walletWif is only for scripted runs (e.g. the live testnet check reusing a faucet-funded key); the app always generates a fresh one. */
async function createDevice(input: { passphrase: string; displayName: string; master?: { unitName: string }; walletWif?: string }, storage: Storage2) {
  validatePassphrase(input.passphrase); const displayName = validateDisplayName(input.displayName)
  if (storage.getItem(DEVICE_VAULT_STORAGE_KEY)) throw new Error('This device is already set up. Unlock it instead.')
  const salt = crypto.getRandomValues(new Uint8Array(16)), vaultKey = await deriveVaultKey(input.passphrase, salt), createdAt = new Date().toISOString()
  const signing = await newSigningKey(), ecdh = await newEcdhKey(), wallet = input.walletWif ? walletFromWif(input.walletWif) : newWalletWif()
  const secrets: Record<string, SealedSecret> = { signing: await seal(vaultKey, 'signing', signing.jwk), ecdh: await seal(vaultKey, 'ecdh', ecdh.jwk), wallet: await seal(vaultKey, 'wallet', wallet.wif) }
  const record: DeviceVaultRecord = { version: 2, kdf: { name: 'PBKDF2-SHA-256', iterations: KDF_ITERATIONS, salt: b64url(salt) }, secrets, signingIdentity: signing.identity, ecdhPublicKey: ecdh.publicKey, walletAddress: wallet.address, displayName, role: 'PENDING', createdAt }
  if (input.master) {
    const unitName = input.master.unitName.trim(); if (!unitName || unitName.length > 80) throw new Error('Enter the unit name (1–80 characters).')
    const authority = await newSigningKey(), epoch = 'e1', unitKey = b64url(crypto.getRandomValues(new Uint8Array(32)))
    secrets.authority = await seal(vaultKey, 'authority', authority.jwk)
    secrets[epochSecretName(epoch)] = await seal(vaultKey, epochSecretName(epoch), unitKey)
    const authoritySigner = await importSigner(authority.jwk, authority.identity)
    record.credential = await issueCredential(authoritySigner, { subjectPublicIdentity: signing.identity, role: 'MASTER', permissions: [...ROLE_PERMISSIONS.MASTER], issuedAt: createdAt })
    record.role = 'MASTER'
    record.unit = { unitId: `u-${randomHex(10)}`, unitName, authorityIdentity: authority.identity, currentEpoch: epoch, epochs: [epoch], joinedAt: createdAt }
    record.admissions = []
  }
  saveDeviceVault(record, storage)
  return unlockDevice(record, input.passphrase)
}
/** First device of a unit: creates the unit, its authority key, the first unit data key, and self-issues a MASTER credential. */
export const createMasterDevice = (input: { passphrase: string; displayName: string; unitName: string; walletWif?: string }, storage: Storage2 = localStorage) => createDevice({ passphrase: input.passphrase, displayName: input.displayName, master: { unitName: input.unitName }, ...(input.walletWif ? { walletWif: input.walletWif } : {}) }, storage)
/** Any other device: creates its own keys and waits for the Master's admission code. */
export const createJoiningDevice = (input: { passphrase: string; displayName: string; walletWif?: string }, storage: Storage2 = localStorage) => createDevice(input, storage)

const failures = { count: 0, blockedUntil: 0 }
export async function unlockDevice(record: DeviceVaultRecord, passphrase: string): Promise<UnlockedDevice> {
  if (Date.now() < failures.blockedUntil) throw new Error('Too many wrong passphrases. Wait one minute and try again.')
  if (record.version !== 2 || record.kdf.name !== 'PBKDF2-SHA-256' || record.kdf.iterations !== KDF_ITERATIONS) throw new Error('Unsupported device record format.')
  let vaultKey: CryptoKey, signingJwk: string
  try { vaultKey = await deriveVaultKey(passphrase, fromB64url(record.kdf.salt)); signingJwk = await unseal(vaultKey, 'signing', record.secrets.signing) }
  catch (error) { failures.count++; if (failures.count >= 5) { failures.blockedUntil = Date.now() + 60_000; failures.count = 0 } throw new Error('That passphrase is not correct for this device.', { cause: error }) }
  failures.count = 0
  const identity = await importSigner(signingJwk, record.signingIdentity)
  const ecdhPrivateKey = await importEcdhPrivate(await unseal(vaultKey, 'ecdh', record.secrets.ecdh))
  const walletWif = await unseal(vaultKey, 'wallet', record.secrets.wallet)
  const authoritySigner = record.secrets.authority && record.unit ? await importSigner(await unseal(vaultKey, 'authority', record.secrets.authority), record.unit.authorityIdentity) : undefined
  const unitKeys = new Map<string, CryptoKey>()
  for (const epoch of record.unit?.epochs ?? []) { const sealed = record.secrets[epochSecretName(epoch)]; if (sealed) unitKeys.set(epoch, await importUnitKey(await unseal(vaultKey, epochSecretName(epoch), sealed), record.role === 'MASTER')) }
  return { record, identity, ...(authoritySigner ? { authoritySigner } : {}), ecdhPrivateKey, walletWif, unitKeys, vaultKey }
}

/** Public, non-secret code a joining device shows so the Master can admit it. Safe to text, email or read aloud. */
export const encodeJoinRequest = (device: UnlockedDevice) => encodeCode('JOIN', { identity: device.record.signingIdentity, ecdh: device.record.ecdhPublicKey, wallet: device.record.walletAddress, name: device.record.displayName } satisfies JoinRequest)
export async function decodeJoinRequest(code: string): Promise<JoinRequest> {
  const value = await decodeCode<JoinRequest>('JOIN', code)
  if (typeof value?.identity !== 'string' || !value.identity.startsWith('p256:') || typeof value.ecdh !== 'string' || typeof value.wallet !== 'string' || typeof value.name !== 'string') throw new Error('This is not a valid join code.')
  await importEcdhPublic(value.ecdh).catch(() => { throw new Error('This join code is damaged.') })
  return { ...value, name: validateDisplayName(value.name) }
}

/**
 * The Master admits a person: signs a credential for their public identity and wraps every unit
 * data key to their ECDH public key. The returned admission code contains no usable secret — only
 * the device that generated the join code can unwrap it — so it can travel over any channel.
 */
export async function admitMember(master: UnlockedDevice, joinCode: string, role: Exclude<ArgusRole, 'MASTER'>, options: { expiresAt?: string; displayName?: string; storage?: Storage2 } = {}) {
  const { record } = master
  if (record.role !== 'MASTER' || !master.authoritySigner || !record.unit || !record.credential) throw new Error('Only the unit Master can admit people.')
  const request = await decodeJoinRequest(joinCode)
  if (request.identity === record.signingIdentity) throw new Error('That is this device’s own join code.')
  const displayName = validateDisplayName(options.displayName ?? request.name)
  const credential = await issueCredential(master.authoritySigner, { subjectPublicIdentity: request.identity, role, permissions: [...ROLE_PERMISSIONS[role]], issuedAt: new Date().toISOString(), ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}) })
  const granteeEcdh = await importEcdhPublic(request.ecdh), grants: KeyGrantRecord[] = []
  for (const epochId of record.unit.epochs) {
    const epochKey = master.unitKeys.get(epochId); if (!epochKey) throw new Error(`This device is missing unit key ${epochId}.`)
    grants.push(await wrapEpochKeyForGrant({ epochKey, organizationId: record.unit.unitId, epochId, granteePublicIdentity: request.identity, grantorPublicIdentity: record.signingIdentity, grantorEcdhPrivateKey: master.ecdhPrivateKey, granteeEcdhPublicKey: granteeEcdh, grantorSigner: master.identity }))
  }
  const admission: AdmissionPackage = { unit: { unitId: record.unit.unitId, unitName: record.unit.unitName, authorityIdentity: record.unit.authorityIdentity }, credential, grantor: { identity: record.signingIdentity, ecdh: record.ecdhPublicKey, credential: record.credential }, grants, currentEpoch: record.unit.currentEpoch }
  const entry: AdmissionRecord = { credential, displayName, walletAddress: request.wallet, admittedAt: credential.issuedAt }
  record.admissions = [...(record.admissions ?? []).filter(existing => existing.credential.subjectPublicIdentity !== request.identity), entry]
  saveDeviceVault(record, options.storage ?? localStorage)
  return { admissionCode: await encodeCode('ADMIT', admission), credential, displayName, walletAddress: request.wallet }
}

const unsignedJson = <T extends { signature: string }>(value: T) => { const rest: Partial<T> = { ...value }; delete rest.signature; return canonicalize(rest) }
/** A joining device verifies its admission code, pins the unit authority, unwraps the unit key(s) and stores them sealed under its passphrase key. */
export async function acceptAdmission(device: UnlockedDevice, admissionCode: string, storage: Storage2 = localStorage): Promise<UnlockedDevice> {
  const admission = await decodeCode<AdmissionPackage>('ADMIT', admissionCode)
  const { record } = device
  if (!admission?.unit?.unitId || !admission.credential || !admission.grantor?.credential || !Array.isArray(admission.grants)) throw new Error('This admission code is damaged.')
  if (record.unit && record.unit.unitId !== admission.unit.unitId) throw new Error('This device already belongs to a different unit.')
  const { credential, grantor } = admission, authority = admission.unit.authorityIdentity
  if (credential.subjectPublicIdentity !== record.signingIdentity) throw new Error('This admission code was made for a different device.')
  if (credential.issuedBy !== authority || !(await device.identity.verify(unsignedJson(credential), credential.signature, authority))) throw new Error('This admission code is not signed by the unit authority.')
  if (grantor.credential.issuedBy !== authority || grantor.credential.subjectPublicIdentity !== grantor.identity || grantor.credential.role !== 'MASTER' || !(await device.identity.verify(unsignedJson(grantor.credential), grantor.credential.signature, authority))) throw new Error('The admitting device is not a Master of this unit.')
  const grantorEcdh = await importEcdhPublic(grantor.ecdh), secrets = { ...record.secrets }, epochs: string[] = []
  for (const raw of admission.grants) {
    const grant = parseKeyGrantRecord(raw)
    if (grant.organizationId !== admission.unit.unitId || grant.granteePublicIdentity !== record.signingIdentity || grant.grantorPublicIdentity !== grantor.identity) throw new Error('This admission code contains a key for someone else.')
    if (!(await device.identity.verify(canonicalize(unsignedKeyGrantFields(grant)), grant.signature, grantor.identity))) throw new Error('A unit key in this admission code failed its signature check.')
    const key = await unwrapEpochKeyFromGrant(grant, { granteeEcdhPrivateKey: device.ecdhPrivateKey, grantorEcdhPublicKey: grantorEcdh, extractable: true })
    const raw32 = b64url(new Uint8Array(await crypto.subtle.exportKey('raw', key)))
    secrets[epochSecretName(grant.epochId)] = await seal(device.vaultKey, epochSecretName(grant.epochId), raw32)
    epochs.push(grant.epochId)
  }
  if (!epochs.includes(admission.currentEpoch)) throw new Error('This admission code is missing the current unit key.')
  const updated: DeviceVaultRecord = { ...record, secrets, role: credential.role, credential, unit: { unitId: admission.unit.unitId, unitName: admission.unit.unitName, authorityIdentity: authority, currentEpoch: admission.currentEpoch, epochs: [...new Set(epochs)], joinedAt: new Date().toISOString() } }
  saveDeviceVault(updated, storage)
  const unitKeys = new Map<string, CryptoKey>()
  for (const epoch of updated.unit!.epochs) unitKeys.set(epoch, await importUnitKey(await unseal(device.vaultKey, epochSecretName(epoch), secrets[epochSecretName(epoch)]), false))
  return { ...device, record: updated, unitKeys }
}

/** Removes this device's record. The unit's history is on chain; re-admission gives a fresh device full access again. */
export function forgetDevice(storage: Pick<Storage, 'removeItem'> = localStorage) { storage.removeItem(DEVICE_VAULT_STORAGE_KEY) }
