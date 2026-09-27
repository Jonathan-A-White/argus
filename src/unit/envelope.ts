import { canonicalize } from '../distributed/canonical'
import type { AuthorityCredential, SignedArgusEvent } from '../distributed/types'
import { parseSignedEvent } from '../private-sync/schema'

/**
 * Encrypted A.R.G.U.S. envelope, version 2 — the only thing a unit ever writes to BSV.
 *
 * Public (visible to anyone reading the testnet chain): format version, opaque unit ID, key
 * epoch, random event ID, nonce and ciphertext. Everything else — who acted, what they did, when,
 * cadet IDs and names, sizes, quantities, member display names — is inside AES-256-GCM
 * ciphertext under the unit data key, which only admitted devices hold. The public header is the
 * GCM additional data, so it cannot be altered or replayed under another unit/event ID.
 *
 * Authenticity does not rely on the envelope: the inner event carries the actor's ECDSA
 * signature, and the actor's Master-signed credential travels with it so any member can check
 * the actor's role without contacting anyone.
 */
export type UnitEnvelope = { v: 2; unit: string; epoch: string; eventId: string; z: 0 | 1; nonce: string; ct: string }
export type UnitEnvelopePlaintext = { event: SignedArgusEvent; credential?: AuthorityCredential }

const encoder = new TextEncoder(), decoder = new TextDecoder()
const MAX_ENVELOPE_BYTES = 60 * 1024
export const bytesToBase64 = (bytes: Uint8Array) => { let binary = ''; for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000)); return btoa(binary) }
export const base64ToBytes = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0))
const aad = (envelope: Pick<UnitEnvelope, 'v' | 'unit' | 'epoch' | 'eventId' | 'z'>) => encoder.encode(canonicalize({ v: envelope.v, unit: envelope.unit, epoch: envelope.epoch, eventId: envelope.eventId, z: envelope.z }))
const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer

async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const output = new Blob([buffer(bytes)]).stream().pipeThrough(stream)
  return new Uint8Array(await new Response(output).arrayBuffer())
}
/** Deflate when the runtime supports it; envelopes record whether they were compressed so any device can read any other's. */
async function compress(bytes: Uint8Array): Promise<{ z: 0 | 1; bytes: Uint8Array }> {
  if (typeof CompressionStream === 'undefined') return { z: 0, bytes }
  try { const packed = await transform(bytes, new CompressionStream('deflate-raw')); return packed.length < bytes.length ? { z: 1, bytes: packed } : { z: 0, bytes } } catch { return { z: 0, bytes } }
}
async function decompress(bytes: Uint8Array, z: 0 | 1) {
  if (!z) return bytes
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot read compressed A.R.G.U.S. records; update it.')
  return transform(bytes, new DecompressionStream('deflate-raw'))
}

export async function sealEnvelope(input: { unitId: string; epochId: string; key: CryptoKey; plaintext: UnitEnvelopePlaintext }): Promise<UnitEnvelope> {
  const { event } = input.plaintext
  if (event.organizationId !== input.unitId) throw new Error('Event belongs to a different unit.')
  const packed = await compress(encoder.encode(JSON.stringify(input.plaintext)))
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const header = { v: 2 as const, unit: input.unitId, epoch: input.epochId, eventId: event.eventId, z: packed.z }
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(header), tagLength: 128 }, input.key, buffer(packed.bytes)))
  const envelope: UnitEnvelope = { ...header, nonce: bytesToBase64(nonce), ct: bytesToBase64(ciphertext) }
  if (serializeEnvelope(envelope).length > MAX_ENVELOPE_BYTES) throw new Error('This record is too large to publish.')
  return envelope
}

export async function openEnvelope(envelope: UnitEnvelope, keyFor: (epochId: string) => Promise<CryptoKey | undefined>): Promise<UnitEnvelopePlaintext> {
  const key = await keyFor(envelope.epoch)
  if (!key) throw new Error(`NO_EPOCH_KEY: this device has no key for ${envelope.epoch}.`)
  let clear: Uint8Array
  try { clear = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buffer(base64ToBytes(envelope.nonce)), additionalData: aad(envelope), tagLength: 128 }, key, buffer(base64ToBytes(envelope.ct)))) }
  catch { throw new Error('Envelope authentication failed: wrong unit key or tampered record.') }
  const parsed = JSON.parse(decoder.decode(await decompress(clear, envelope.z))) as { event?: unknown; credential?: AuthorityCredential }
  const event = parseSignedEvent(parsed.event)
  if (event.eventId !== envelope.eventId || event.organizationId !== envelope.unit) throw new Error('Envelope header does not match its event.')
  return { event, ...(parsed.credential ? { credential: parsed.credential } : {}) }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
export function parseEnvelope(value: unknown): UnitEnvelope {
  if (!record(value) || value.v !== 2 || (value.z !== 0 && value.z !== 1)) throw new Error('Unsupported A.R.G.U.S. envelope.')
  for (const field of ['unit', 'epoch', 'eventId', 'nonce', 'ct'] as const) if (typeof value[field] !== 'string' || !value[field] || (value[field] as string).length > MAX_ENVELOPE_BYTES) throw new Error(`Invalid envelope field: ${field}.`)
  return { v: 2, unit: value.unit as string, epoch: value.epoch as string, eventId: value.eventId as string, z: value.z, nonce: value.nonce as string, ct: value.ct as string }
}
export const serializeEnvelope = (envelope: UnitEnvelope) => encoder.encode(canonicalize(envelope))
export const deserializeEnvelope = (bytes: Uint8Array) => parseEnvelope(JSON.parse(decoder.decode(bytes)))
/** The complete set of fields that ever appear in plaintext on chain. Tests assert nothing else leaks. */
export const PUBLIC_ENVELOPE_FIELDS = ['v', 'unit', 'epoch', 'eventId', 'z', 'nonce', 'ct'] as const
