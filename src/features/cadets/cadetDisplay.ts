import { matchesSearch } from '../../domain'
import type { CadetProjection, InventoryProjection, MemberProjection } from '../../distributed/types'
import { CADET_CODE_PATTERN, cadetLabel } from '../../stage3/domain'

type CadetIdentity = Pick<CadetProjection, 'cadetCode' | 'cadetId'>

/** Names are the everyday staff-facing identity; the opaque code remains a fallback for unnamed records. */
export const cadetDisplayName = (cadet: CadetIdentity & Pick<CadetProjection, 'fullName'>) => cadet.fullName.trim() || cadetLabel(cadet)

/**
 * Two characters of the opaque cadet ID, shown where other apps would show initials.
 * Never derived from the (encrypted, optional) name.
 */
export const cadetMonogram = (cadet: CadetIdentity) => cadetLabel(cadet).replace(/^C-/, '').slice(0, 2)

/**
 * Staff may find a cadet by typing the name, the cadet ID, the NS level or the status.
 * Names are encrypted at rest and are shown to staff after the unit is unlocked.
 */
export function cadetMatches(cadet: CadetIdentity & Pick<CadetProjection, 'fullName' | 'nsLevel' | 'status'>, query: string) {
  const reversedName = cadet.fullName.split(/\s+/).reverse().join(' ')
  return matchesSearch(query, cadetLabel(cadet), cadet.fullName, reversedName, cadet.nsLevel, cadet.status)
}

/** Normalizes a typed cadet ID ("c-4f7k " → "C-4F7K"). Returns '' for blank input (meaning: generate one). */
export const normalizeCadetCode = (value: string) => value.trim().toUpperCase()

export function cadetCodeError(code: string, takenCodes: Iterable<string>) {
  if (!code) return ''
  if (!CADET_CODE_PATTERN.test(code)) return 'Cadet IDs look like C-4F7K (C- followed by 4–6 letters or digits).'
  for (const taken of takenCodes) if (taken === code) return `Cadet ID ${code} is already in use.`
  return ''
}

/**
 * How a staff member (never a cadet) is named in history rows: "You" for this device's identity,
 * otherwise the display name from their admission, otherwise a neutral fallback.
 */
export function memberLabel(projection: { actor: string; members: Pick<MemberProjection, 'publicIdentity' | 'displayName'>[] }, publicIdentity: string) {
  if (publicIdentity === projection.actor) return 'You'
  return projection.members.find(member => member.publicIdentity === publicIdentity)?.displayName ?? 'Unit member'
}

/**
 * Sizes an issued line can be corrected to: the other active sizes of the same catalog item, in the
 * order they were added. Legacy stock without a catalog item has no sibling sizes to offer.
 */
export function correctionOptions(inventory: InventoryProjection[], itemId: string) {
  const current = inventory.find(item => item.entityId === itemId)
  if (!current?.catalogId) return []
  return inventory.filter(item => item.catalogId === current.catalogId && item.active && item.entityId !== itemId)
}
