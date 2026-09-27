/** Search helpers shared by every list. Common supply abbreviations also match their long forms. */
const ABBREVIATIONS: Record<string, string> = { pt: 'physical training', nsu: 'navy service uniform', sdb: 'service dress blue', oxford: 'shoe' }
const tokens = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)

export function normalizeSearch(value: string) {
  return tokens(value).map(token => ABBREVIATIONS[token] ?? token).join(' ')
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
