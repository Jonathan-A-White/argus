/** Search helpers shared by every list. Common supply abbreviations also match their long forms. */
export const ABBREVIATIONS: Record<string, string> = {
  // uniforms and programs
  pt: 'physical training', nsu: 'navy service uniform', sdb: 'service dress blue', nwu: 'navy working uniform',
  // colours
  blk: 'black', wht: 'white', kha: 'khaki', khk: 'khaki', gld: 'gold', nvy: 'navy',
  // garments, covers and footwear
  jkt: 'jacket', trs: 'trousers', trsr: 'trousers', slk: 'slacks', shrt: 'shirt', blse: 'blouse', gar: 'garrison', cvr: 'cover', sox: 'socks', bkl: 'buckle',
  ox: 'oxford', oxf: 'oxford', oxford: 'shoe', pmp: 'pumps',
  // counting and sizing
  cnt: 'count', sz: 'size', qty: 'quantity',
}
/** Own keys only, so a word like "constructor" is never mistaken for an abbreviation. */
export const expandAbbreviation = (word: string): string | undefined => (Object.hasOwn(ABBREVIATIONS, word) ? ABBREVIATIONS[word] : undefined)
const tokens = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)

export function normalizeSearch(value: string) {
  return tokens(value).map(token => expandAbbreviation(token) ?? token).join(' ')
}

/** True when the query matches any field, comparing both as typed and with abbreviations expanded (so "oxford" finds "Black Oxfords" and "PT" finds "Physical Training"). */
export function matchesSearch(query: string, ...fields: string[]) {
  const raw = tokens(query).join(' ')
  if (!raw) return true
  const needles = [...new Set([raw, normalizeSearch(query)])]
  return fields.some(field => {
    const haystacks = [...new Set([tokens(field).join(' '), normalizeSearch(field)])]
    return needles.some(needle => haystacks.some(haystack => haystack.replaceAll(' ', '').includes(needle.replaceAll(' ', '')) || needle.split(' ').every(word => haystack.includes(word))))
  })
}

// ---------- inventory search (item name, abbreviation, size, category, NIIN/reference) ----------

/** Singular form used for comparison only: shirts → shirt, accessories → accessory, dresses → dress. */
export function singular(word: string) {
  if (word.length <= 3 || /\d/.test(word)) return word
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (/(ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2)
  if (word.endsWith('s') && !/(ss|us|is)$/.test(word)) return word.slice(0, -1)
  return word
}

const FRACTION_GLYPHS: Record<string, string> = { '½': ' 1/2', '¼': ' 1/4', '¾': ' 3/4', '⅛': ' 1/8', '⅜': ' 3/8', '⅝': ' 5/8', '⅞': ' 7/8' }
const withDecimalFractions = (value: string) => {
  let result = value
  for (const [glyph, text] of Object.entries(FRACTION_GLYPHS)) result = result.replaceAll(glyph, text)
  return result.replace(/(\d+)\s+(\d+)\s*\/\s*(\d+)/g, (match, whole: string, top: string, bottom: string) => (Number(bottom) ? String(Number(whole) + Number(top) / Number(bottom)) : match))
}

/** Canonical size for comparison: "34 R", "34-r" → "34R"; "7 1/2", "7½" → "7.5"; "7.5 w" → "7.5W". */
export function sizeKey(label: string) {
  return withDecimalFractions(label).toUpperCase().replace(/[\s_-]+/g, '')
}

/** Letters people type after a number for a size: 34 R, 7.5 W, 6 JP, 2 XL. */
const SIZE_SUFFIX = /^[xsrlwmnjptc]{1,3}$/
/** Words that only describe what is being searched for. */
const FILLER = new Set(['size', 'sizes', 'sz'])
/** Spelled-out sizes also find the letter size. */
const SIZE_WORDS: Record<string, string> = { small: 'S', sm: 'S', medium: 'M', med: 'M', md: 'M', large: 'L', lg: 'L', lrg: 'L', xsmall: 'XS', xlarge: 'XL' }
const alphanumeric = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '')

/** The search terms of a query: fractions become decimals and "34 R" / "34-R" become one size term. */
export function searchTerms(query: string) {
  const joined = withDecimalFractions(query.toLowerCase()).replace(/(\d(?:\.\d+)?)[\s-]+([a-z]{1,3})(?![a-z0-9])/g, (match, number: string, letters: string) => (SIZE_SUFFIX.test(letters) && !expandAbbreviation(letters) ? `${number}${letters}` : match))
  return joined
    .split(/[\s,;]+/)
    .map(term => term.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
    .filter(term => term && !FILLER.has(term))
}

export type SearchableItem = { name: string; category?: string; niin?: string; sizes?: string[] }

/** Every word an item can be found by: as written, singular, and the long form of any abbreviation. */
function itemWords(item: SearchableItem) {
  const words = new Set<string>()
  for (const token of tokens(`${item.name} ${item.category ?? ''}`)) {
    for (const form of [token, singular(token)]) {
      words.add(form)
      const expansion = expandAbbreviation(form)
      if (expansion) for (const word of tokens(expansion)) { words.add(word); words.add(singular(word)) }
    }
  }
  return words
}

/**
 * Inventory search: every term of the query must match the item's name or category (words, their
 * singulars and abbreviations), one of its sizes, or its NIIN/reference. One-letter terms must match
 * a whole word or size exactly, so "m" finds items stocked in M rather than every name with an "m";
 * two letters match the start of a word or size ("34" finds 34R and 34L); longer terms may match
 * anywhere in a word ("tie" finds Necktie).
 */
export function matchesItemSearch(query: string, item: SearchableItem) {
  const terms = searchTerms(query)
  if (!terms.length) return true
  const niin = alphanumeric(item.niin ?? '')
  const wholeQuery = alphanumeric(query)
  if (niin && wholeQuery.length >= 4 && niin.includes(wholeQuery)) return true
  const words = [...itemWords(item)]
  const sizes = (item.sizes ?? []).map(sizeKey)
  const wordMatches = (candidate: string) => words.some(word => (candidate.length === 1 ? word === candidate : candidate.length === 2 ? word.startsWith(candidate) : word.includes(candidate)))
  return terms.every(term => {
    const key = sizeKey(term), alias = Object.hasOwn(SIZE_WORDS, term) ? SIZE_WORDS[term] : undefined
    if (sizes.some(size => size === key || (key.length >= 2 && size.startsWith(key)) || size === alias)) return true
    const reference = alphanumeric(term)
    if (niin && reference.length >= 3 && niin.includes(reference)) return true
    const parts = tokens(term)
    return parts.length > 0 && parts.every(part => {
      if (wordMatches(part) || wordMatches(singular(part))) return true
      const expansion = expandAbbreviation(part)
      return expansion !== undefined && tokens(expansion).every(word => wordMatches(singular(word)))
    })
  })
}

/** Canonical words of an item name for duplicate detection: lower case, no punctuation, abbreviations expanded, singular. */
export function nameTokens(name: string) {
  const result: string[] = []
  for (const token of tokens(name)) {
    const expansion = expandAbbreviation(token) ?? expandAbbreviation(singular(token))
    for (const word of expansion ? tokens(expansion) : [token]) if (!STOP_WORDS.has(word)) result.push(singular(word))
  }
  return result
}
const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'and', 'for', 'with'])
