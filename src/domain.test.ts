import { describe, expect, it } from 'vitest'
import { matchesSearch, normalizeSearch } from './domain'

describe('search normalization', () => {
  it('matches NIINs regardless of punctuation and common supply abbreviations', () => {
    expect(matchesSearch('8415 01 2041', '8415-01-2041')).toBe(true)
    expect(matchesSearch('PT shirt', 'Physical Training Shirt')).toBe(true)
    expect(matchesSearch('shorts m', 'PT Shorts', 'M')).toBe(false)
    expect(matchesSearch('', 'anything')).toBe(true)
    expect(matchesSearch('oxford', 'Black Oxfords')).toBe(true)
    expect(matchesSearch('oxfords', 'Black Oxfords')).toBe(true)
    expect(matchesSearch('sdb jacket', 'Male SDB Jacket')).toBe(true)
    expect(normalizeSearch('  NSU—Khaki  ')).toBe('navy service uniform khaki')
  })
})
