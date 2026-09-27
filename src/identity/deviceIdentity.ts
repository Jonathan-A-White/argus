import { AuthorizationService, ROLE_PERMISSIONS, issueCredential } from '../auth/authorization'
import type { ArgusRole, AuthorityCredential } from '../distributed/types'
import { decodeCredentialCode, decodeIdentityCode, encodeCredentialCode } from './codes'
import { createWrappedApplicationCredential, unlockWrappedApplicationCredential, type ArgusIdentityProvider, type WrappedApplicationCredential } from './identity'

export const DEVICE_IDENTITY_STORAGE_KEY = 'argus.identity.device.v1'

export type DeviceRole = ArgusRole | 'PENDING'

/** Persisted on this device only. Every key field is password-wrapped ciphertext; nothing here is a usable private key. */
export type DeviceIdentityRecord = {
  version: 1
  role: DeviceRole
  applicationCredential: WrappedApplicationCredential
  authorityCredential?: AuthorityCredential
  authorityKey?: WrappedApplicationCredential
  pinnedAuthority?: string
  admittedCredentials?: AuthorityCredential[]
  createdAt: string
}

export type UnlockedDeviceIdentity = {
  publicIdentity: string
  role: DeviceRole
  identity: ArgusIdentityProvider
  authorization?: AuthorizationService
  authoritySigner?: ArgusIdentityProvider
}

export type KnownPerson = { publicIdentity: string; role: ArgusRole; issuedAt?: string; you: boolean }

export function loadDeviceIdentityRecord(storage: Pick<Storage, 'getItem'> = localStorage): DeviceIdentityRecord | undefined {
  const raw = storage.getItem(DEVICE_IDENTITY_STORAGE_KEY)
  if (!raw) return undefined
  const parsed = JSON.parse(raw) as Partial<DeviceIdentityRecord>
  if (parsed.version !== 1 || !parsed.applicationCredential || !parsed.role) throw new Error('The stored A.R.G.U.S. device identity is unreadable.')
  return parsed as DeviceIdentityRecord
}

function save(record: DeviceIdentityRecord, storage: Pick<Storage, 'setItem'>) {
  storage.setItem(DEVICE_IDENTITY_STORAGE_KEY, JSON.stringify(record))
  return record
}

/** The first device in a unit: generates its own application key plus the unit's org authority key, and self-issues a MASTER credential. */
export async function createMasterDeviceIdentity(password: string, storage: Pick<Storage, 'setItem'> = localStorage): Promise<DeviceIdentityRecord> {
  const createdAt = new Date().toISOString()
  const authorityKey = await createWrappedApplicationCredential(password, createdAt)
  const applicationCredential = await createWrappedApplicationCredential(password, createdAt)
  const authoritySigner = await unlockWrappedApplicationCredential(authorityKey, password)
  const authorityCredential = await issueCredential(authoritySigner, {
    subjectPublicIdentity: applicationCredential.publicIdentity,
    role: 'MASTER',
    permissions: [...ROLE_PERMISSIONS.MASTER],
    issuedAt: createdAt,
  })
  return save({ version: 1, role: 'MASTER', applicationCredential, authorityCredential, authorityKey, createdAt }, storage)
}

/** A device joining an existing unit: generates only its own application key. Admission by the Master is a later story. */
export async function createJoiningDeviceIdentity(password: string, storage: Pick<Storage, 'setItem'> = localStorage): Promise<DeviceIdentityRecord> {
  const createdAt = new Date().toISOString()
  const applicationCredential = await createWrappedApplicationCredential(password, createdAt)
  return save({ version: 1, role: 'PENDING', applicationCredential, createdAt }, storage)
}

export async function unlockDeviceIdentity(record: DeviceIdentityRecord, password: string): Promise<UnlockedDeviceIdentity> {
  const identity = await unlockWrappedApplicationCredential(record.applicationCredential, password)
  const publicIdentity = record.applicationCredential.publicIdentity
  if (record.role === 'MASTER' && record.authorityCredential && record.authorityKey) {
    const authoritySigner = await unlockWrappedApplicationCredential(record.authorityKey, password)
    const authorization = await attachAuthorityCredential(identity, record.authorityCredential)
    return { identity, authorization, authoritySigner, role: 'MASTER', publicIdentity }
  }
  if (record.role !== 'PENDING' && record.authorityCredential) {
    const authorization = await attachAuthorityCredential(identity, record.authorityCredential)
    return { identity, authorization, role: record.role, publicIdentity }
  }
  return { identity, role: 'PENDING', publicIdentity }
}

async function attachAuthorityCredential(identity: ArgusIdentityProvider, credential: AuthorityCredential): Promise<AuthorizationService> {
  const authorization = new AuthorizationService(credential.issuedBy, identity)
  await authorization.acceptCredential(credential)
  return authorization
}

/** The Master admits a person: issues a signed credential for the pasted identity code and records the admission. */
export async function admitPerson(
  record: DeviceIdentityRecord,
  authoritySigner: ArgusIdentityProvider,
  identityCode: string,
  role: Exclude<ArgusRole, 'MASTER'>,
  expiresAt: string | undefined,
  storage: Pick<Storage, 'setItem'> = localStorage,
): Promise<{ record: DeviceIdentityRecord; credentialCode: string }> {
  const subjectPublicIdentity = await decodeIdentityCode(identityCode)
  const credential = await issueCredential(authoritySigner, {
    subjectPublicIdentity,
    role,
    permissions: [...ROLE_PERMISSIONS[role]],
    issuedAt: new Date().toISOString(),
    ...(expiresAt ? { expiresAt } : {}),
  })
  const updated = save({ ...record, admittedCredentials: [...(record.admittedCredentials ?? []), credential] }, storage)
  return { record: updated, credentialCode: await encodeCredentialCode(credential) }
}

/** A joining device pastes its credential: verifies the signature, pins the issuing Master as this device's trusted root, and takes the credential's role. A later credential from a different, already-pinned root is refused. */
export async function admitDeviceWithCredential(
  record: DeviceIdentityRecord,
  identity: ArgusIdentityProvider,
  credentialCode: string,
  storage: Pick<Storage, 'setItem'> = localStorage,
): Promise<{ record: DeviceIdentityRecord; authorization: AuthorizationService }> {
  const credential = await decodeCredentialCode(credentialCode)
  if (record.pinnedAuthority && credential.issuedBy !== record.pinnedAuthority) {
    throw new Error(`This credential was signed by a different Master (${credential.issuedBy}) than the one already trusted by this device (${record.pinnedAuthority}).`)
  }
  const authorization = await attachAuthorityCredential(identity, credential)
  if (credential.subjectPublicIdentity !== record.applicationCredential.publicIdentity) throw new Error('This credential was issued to a different device.')
  const updated = save({ ...record, role: credential.role, authorityCredential: credential, pinnedAuthority: credential.issuedBy }, storage)
  return { record: updated, authorization }
}

/** The people this device knows: itself, and every credential it has seen. The Master keeps every credential it issued; a non-Master device knows only the Master that admitted it until the chain arrives in a later epic. */
export function knownPeople(record: DeviceIdentityRecord): KnownPerson[] {
  if (record.role === 'PENDING') return []
  const you: KnownPerson = { publicIdentity: record.applicationCredential.publicIdentity, role: record.role, issuedAt: record.authorityCredential?.issuedAt ?? record.createdAt, you: true }
  if (record.role === 'MASTER') {
    return [you, ...(record.admittedCredentials ?? []).map(c => ({ publicIdentity: c.subjectPublicIdentity, role: c.role, issuedAt: c.issuedAt, you: false }))]
  }
  if (record.authorityCredential) return [you, { publicIdentity: record.authorityCredential.issuedBy, role: 'MASTER' as ArgusRole, you: false }]
  return [you]
}
