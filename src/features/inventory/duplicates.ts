import type { CatalogItemProjection } from '../../distributed/types'
import { nameTokens } from '../../domain'

/**
 * Likely-duplicate detection for the catalog (master spec §7). It only warns — a unit may really
 * stock two similar items — so it favours the cases people actually hit: the same name typed
 * differently ("Blk Oxfords" vs "Black Oxfords", "PT Shorts" vs "Shorts, PT"), the same NIIN, or
 * mostly the same words, while items that differ by gender, colour or top/bottom stay distinct.
 */
export type DuplicateReason = 'SAME_NAME' | 'SAME_NIIN' | 'SIMILAR_NAME'
export type LikelyDuplicate = { item: CatalogItemProjection; reasons: DuplicateReason[]; score: number }

export const SIMILARITY_THRESHOLD = 0.6
const PLACEHOLDER_REFERENCES = new Set(['NA', 'NONE', 'TBD', 'NOTASSIGNED', 'UNKNOWN', 'NIL', 'PENDING'])
/** Words that make otherwise similar names different items. */
const QUALIFIER_GROUPS: Array<Record<string, string>> = [
  { male: 'male', men: 'male', man: 'male', boy: 'male', female: 'female', women: 'female', woman: 'female', lady: 'female', girl: 'female' },
  Object.fromEntries(['black', 'white', 'khaki', 'gold', 'navy', 'blue', 'brass', 'silver', 'gray', 'grey', 'green', 'red', 'brown', 'tan'].map(color => [color, color === 'grey' ? 'gray' : color])),
  { top: 'top', bottom: 'bottom', jacket: 'top', shirt: 'top', trouser: 'bottom', slack: 'bottom', skirt: 'bottom' },
]

/** NIIN / reference for comparison: letters and digits only; an NSN (13 digits) compares by its NIIN (last 9). */
export function referenceKey(niin: string) {
  const key = niin.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (key.length < 4 || PLACEHOLDER_REFERENCES.has(key)) return ''
  return /^\d{13}$/.test(key) ? key.slice(4) : key
}

const nameKey = (words: string[]) => [...new Set(words)].sort().join(' ')

function conflictingQualifiers(a: Set<string>, b: Set<string>) {
  return QUALIFIER_GROUPS.some(group => {
    const left = new Set([...a].filter(word => Object.hasOwn(group, word)).map(word => group[word]))
    const right = new Set([...b].filter(word => Object.hasOwn(group, word)).map(word => group[word]))
    return left.size > 0 && right.size > 0 && ![...left].some(value => right.has(value))
  })
}

function jaccard(a: Set<string>, b: Set<string>) {
  const shared = [...a].filter(word => b.has(word)).length
  const union = new Set([...a, ...b]).size
  return union ? shared / union : 0
}

/** Catalog items that are probably the same thing as `candidate`, most likely first. */
export function findLikelyDuplicates(candidate: { name: string; niin?: string }, catalog: CatalogItemProjection[], options: { excludeCatalogId?: string; limit?: number } = {}): LikelyDuplicate[] {
  const words = nameTokens(candidate.name), key = nameKey(words), reference = referenceKey(candidate.niin ?? '')
  const wordSet = new Set(words)
  if (!key && !reference) return []
  const matches: LikelyDuplicate[] = []
  for (const item of catalog) {
    if (item.catalogId === options.excludeCatalogId) continue
    const itemWords = nameTokens(item.name), itemSet = new Set(itemWords), reasons: DuplicateReason[] = []
    let score = 0
    if (key && nameKey(itemWords) === key) { reasons.push('SAME_NAME'); score += 3 }
    if (reference && referenceKey(item.niin) === reference) { reasons.push('SAME_NIIN'); score += 2 }
    if (!reasons.includes('SAME_NAME') && key) {
      const similarity = jaccard(wordSet, itemSet)
      if (similarity >= SIMILARITY_THRESHOLD && !conflictingQualifiers(wordSet, itemSet)) { reasons.push('SIMILAR_NAME'); score += similarity }
    }
    if (reasons.length) matches.push({ item, reasons, score })
  }
  return matches.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name)).slice(0, options.limit ?? 3)
}

const REASON_TEXT: Record<DuplicateReason, string> = { SAME_NAME: 'same name', SAME_NIIN: 'same NIIN', SIMILAR_NAME: 'similar name' }
export const describeDuplicate = (duplicate: LikelyDuplicate) => duplicate.reasons.map(reason => REASON_TEXT[reason]).join(', ')
