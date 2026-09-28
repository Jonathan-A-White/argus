import type { EncryptedArgusEnvelope, KeyGrantRecord } from './types'
import type { SignedArgusEvent } from '../distributed/types'

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
export function parseEncryptedEnvelope(value: unknown): EncryptedArgusEnvelope {
  if (!record(value) || value.protocol !== 'ARGUS_PRIVATE_EVENT' || value.protocolVersion !== 1 || value.algorithm !== 'AES-256-GCM') throw new Error('Unsupported encrypted envelope protocol.')
  for (const field of ['organizationId', 'eventId', 'epochId', 'senderPublicIdentity', 'nonce', 'ciphertext', 'ciphertextHash', 'signature']) if (typeof value[field] !== 'string' || !value[field]) throw new Error(`Invalid encrypted envelope field: ${field}.`)
  return value as EncryptedArgusEnvelope
}
/** The complete set of plaintext fields a KEY_GRANT record may carry; used to assert no personal data leaks onto the chain. */
export const KEY_GRANT_RECORD_FIELDS = ['protocol', 'protocolVersion', 'organizationId', 'epochId', 'granteePublicIdentity', 'grantorPublicIdentity', 'wrappedKey', 'nonce', 'signature'] as const
export function parseKeyGrantRecord(value: unknown): KeyGrantRecord {
  if (!record(value) || value.protocol !== 'ARGUS_KEY_GRANT' || value.protocolVersion !== 1) throw new Error('Unsupported key grant record protocol.')
  for (const field of ['organizationId', 'epochId', 'granteePublicIdentity', 'grantorPublicIdentity', 'wrappedKey', 'nonce', 'signature']) if (typeof value[field] !== 'string' || !value[field]) throw new Error(`Invalid key grant record field: ${field}.`)
  return value as KeyGrantRecord
}
export function parseSignedEvent(value: unknown): SignedArgusEvent {
  if (!record(value) || value.protocol !== 'ARGUS' || value.protocolVersion !== 1 || value.eventVersion !== 1 || typeof value.organizationId !== 'string' || typeof value.eventId !== 'string' || typeof value.eventType !== 'string' || typeof value.entityId !== 'string' || typeof value.actorPublicIdentity !== 'string' || typeof value.timestamp !== 'string' || !record(value.payload) || typeof value.signature !== 'string') throw new Error('Invalid or unsupported signed event schema.')
  return value as SignedArgusEvent
}
