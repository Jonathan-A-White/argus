import { matchesSearch } from '../../domain'
import type { CadetProjection } from '../../distributed/types'
import { CADET_CODE_PATTERN, cadetLabel } from '../../stage3/domain'

type CadetIdentity = Pick<CadetProjection, 'cadetCode' | 'cadetId'>

/**
 * Two characters of the opaque cadet ID, shown where other apps would show initials.
 * Never derived from the (encrypted, optional) name.
 */
export const cadetMonogram = (cadet: CadetIdentity) => cadetLabel(cadet).replace(/^C-/, '').slice(0, 2)

/**
 * Staff may find a cadet by typing the name, the cadet ID, the NS level or the status.
 * Callers must still display only cadetLabel(): a name match never puts the name on screen.
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
