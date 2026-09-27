import { AuthorizationService, ROLE_PERMISSIONS, issueCredential } from '../auth/authorization'
import type { AuthorityCredential } from '../distributed/types'
import { createWrappedApplicationCredential, unlockWrappedApplicationCredential, type ArgusIdentityProvider, type WrappedApplicationCredential } from './identity'

export const DEVICE_IDENTITY_STORAGE_KEY = 'argus.identity.device.v1'

export type DeviceRole = 'MASTER' | 'PENDING'

/** Persisted on this device only. Every key field is password-wrapped ciphertext; nothing here is a usable private key. */
export type DeviceIdentityRecord = {
  version: 1
  role: DeviceRole
  applicationCredential: WrappedApplicationCredential
  authorityCredential?: AuthorityCredential
  authorityKey?: WrappedApplicationCredential
  createdAt: string
}

export type UnlockedDeviceIdentity = {
  publicIdentity: string
  role: DeviceRole
  identity: ArgusIdentityProvider
  authorization?: AuthorizationService
}

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
  if (record.role === 'MASTER' && record.authorityCredential) {
    const authorization = new AuthorizationService(record.authorityCredential.issuedBy, identity)
    await authorization.acceptCredential(record.authorityCredential)
    return { identity, authorization, role: 'MASTER', publicIdentity }
  }
  return { identity, role: 'PENDING', publicIdentity }
}
