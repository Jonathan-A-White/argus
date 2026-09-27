/** Search helpers shared by every list. Common supply abbreviations match their long forms. */
export function normalizeSearch(value: string) {
  const abbreviations: Record<string, string> = { pt: 'physical training', nsu: 'navy service uniform', oxford: 'shoe' }
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).map(token => abbreviations[token] ?? token).join(' ')
}

export function matchesSearch(query: string, ...fields: string[]) {
  const needle = normalizeSearch(query)
  if (!needle) return true
  const compactNeedle = needle.replaceAll(' ', '')
  const words = needle.split(' ')
  return fields.some(field => {
    const normalized = normalizeSearch(field)
    const haystack = normalized.replaceAll(' ', '')
    return haystack.includes(compactNeedle) || words.every(word => normalized.includes(word))
  })
}
