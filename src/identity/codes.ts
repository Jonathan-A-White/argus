import { sha256 } from '../distributed/canonical'
import type { AuthorityCredential } from '../distributed/types'

const CHECKSUM_LENGTH = 8

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
async function checksum(json: string) { return (await sha256(json)).slice(0, CHECKSUM_LENGTH) }

/** A compact copy/paste/message-friendly encoding: ARGUS-<TAG>-1:<base64url json>:<checksum>. No QR code, no new dependency. */
export async function encodeCode(tag: string, payload: unknown): Promise<string> {
  const json = JSON.stringify(payload)
  return `ARGUS-${tag}-1:${base64url(new TextEncoder().encode(json))}:${await checksum(json)}`
}

export async function decodeCode<T>(tag: string, code: string): Promise<T> {
  const label = tag.toLowerCase()
  const match = code.trim().match(/^ARGUS-([A-Z]+)-1:([A-Za-z0-9_-]+):([0-9a-f]+)$/)
  if (!match || match[1] !== tag) throw new Error(`This is not a valid ${label} code.`)
  const [, , body, sum] = match
  let json: string
  try {
    json = new TextDecoder().decode(fromBase64url(body))
  } catch (cause) {
    throw new Error(`This ${label} code is damaged.`, { cause })
  }
  if (await checksum(json) !== sum) throw new Error(`This ${label} code is damaged.`)
  try {
    return JSON.parse(json) as T
  } catch (cause) {
    throw new Error(`This ${label} code is damaged.`, { cause })
  }
}

export const encodeIdentityCode = (publicIdentity: string) => encodeCode('IDENTITY', publicIdentity)
export const decodeIdentityCode = (code: string) => decodeCode<string>('IDENTITY', code)

export const encodeCredentialCode = (credential: AuthorityCredential) => encodeCode('CREDENTIAL', credential)
export const decodeCredentialCode = (code: string) => decodeCode<AuthorityCredential>('CREDENTIAL', code)
