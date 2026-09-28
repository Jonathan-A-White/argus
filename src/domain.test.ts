import { describe, expect, it } from 'vitest'
import { ABBREVIATIONS, matchesItemSearch, matchesSearch, normalizeSearch, searchTerms, sizeKey } from './domain'

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

describe('inventory search (name, abbreviation, size, category, NIIN)', () => {
  const pumps = { name: 'Pumps', category: 'Footwear', sizes: ['7M', '7.5W', '8N'] }
  const jacket = { name: 'Male SDB Jacket', category: 'SDB', niin: '8405-01-234-5678', sizes: ['32R', '34R', '36L'] }
  const shorts = { name: 'PT Shorts', category: 'PT', sizes: ['S', 'M', 'L'] }
  const shirt = { name: 'Male Khaki Shirt', category: 'NSU', sizes: ['15', '15 1/2'] }
  const cap = { name: 'Garrison Cap', category: 'Covers', sizes: ['7', '7 1/2'] }
  const bottom = { name: 'Tracksuit Bottom', category: 'Drill', sizes: ['L'] }
  const find = (query: string) => [pumps, jacket, shorts, shirt, cap, bottom].filter(item => matchesItemSearch(query, item)).map(item => item.name)

  it('expands realistic NJROTC and uniform abbreviations', () => {
    expect(ABBREVIATIONS).toMatchObject({ nsu: 'navy service uniform', sdb: 'service dress blue', pt: 'physical training', cnt: 'count', blk: 'black', wht: 'white', kha: 'khaki', jkt: 'jacket', trs: 'trousers', slk: 'slacks', shrt: 'shirt', gar: 'garrison', cvr: 'cover', ox: 'oxford', pmp: 'pumps', sz: 'size' })
    expect(matchesItemSearch('blk ox', { name: 'Black Oxfords' })).toBe(true)
    expect(matchesItemSearch('wht shrt', { name: 'White Dress Shirt' })).toBe(true)
    expect(matchesItemSearch('kha trs', { name: 'Khaki Trousers' })).toBe(true)
    expect(matchesItemSearch('slk', { name: 'Black Slacks' })).toBe(true)
    expect(find('sdb jkt')).toEqual(['Male SDB Jacket'])
    expect(find('service dress blue')).toEqual(['Male SDB Jacket'])
    expect(find('pmp')).toEqual(['Pumps'])
    expect(find('gar cvr')).toEqual(['Garrison Cap'])
    expect(find('physical training')).toEqual(['PT Shorts'])
    expect(find('nsu')).toEqual(['Male Khaki Shirt'])
    expect(matchesSearch('fall cnt', 'Fall count')).toBe(true)
  })

  it('matches plurals, partial words and category names', () => {
    expect(find('shirts')).toEqual(['Male Khaki Shirt'])
    expect(find('short')).toEqual(['PT Shorts'])
    expect(find('footwear')).toEqual(['Pumps'])
    expect(find('track')).toEqual(['Tracksuit Bottom'])
    expect(matchesItemSearch('shoes', { name: 'Black Oxfords' })).toBe(true)
    expect(matchesItemSearch('tie', { name: 'Necktie' })).toBe(true)
    expect(find('nothing-like-this')).toEqual([])
    expect(find('')).toHaveLength(6)
  })

  it('treats sizes sensibly: exact letters, chest/length and shoe widths with any punctuation', () => {
    expect(find('m')).toEqual(['PT Shorts'])
    expect(find('M')).toEqual(['PT Shorts'])
    expect(find('medium')).toEqual(['PT Shorts'])
    expect(find('l')).toEqual(['PT Shorts', 'Tracksuit Bottom'])
    expect(find('34R')).toEqual(['Male SDB Jacket'])
    expect(find('34 R')).toEqual(['Male SDB Jacket'])
    expect(find('34-r')).toEqual(['Male SDB Jacket'])
    expect(find('size 34r')).toEqual(['Male SDB Jacket'])
    expect(find('34')).toEqual(['Male SDB Jacket'])
    expect(find('34L')).toEqual([])
    expect(find('7.5W')).toEqual(['Pumps'])
    expect(find('7.5 w')).toEqual(['Pumps'])
    // 7 1/2 is 7.5: the cap size, and 7.5 shoes in any width.
    expect(find('7 1/2')).toEqual(['Pumps', 'Garrison Cap'])
    expect(find('7½')).toEqual(['Pumps', 'Garrison Cap'])
    expect(find('7 1/2 cap')).toEqual(['Garrison Cap'])
    expect(find('15.5')).toEqual(['Male Khaki Shirt'])
    expect(find('pt shorts m')).toEqual(['PT Shorts'])
    expect(find('pt shorts xl')).toEqual([])
    expect(find('jacket 36l')).toEqual(['Male SDB Jacket'])
    expect(sizeKey('34 R')).toBe('34R')
    expect(sizeKey('7 1/2')).toBe('7.5')
    expect(searchTerms('Sz 34-R, PT')).toEqual(['34r', 'pt'])
  })

  it('matches NIIN/reference numbers with or without punctuation, whole or in part', () => {
    expect(find('8405-01-234-5678')).toEqual(['Male SDB Jacket'])
    expect(find('8405 01 234 5678')).toEqual(['Male SDB Jacket'])
    expect(find('840501')).toEqual(['Male SDB Jacket'])
    expect(find('2345678')).toEqual(['Male SDB Jacket'])
  })

  it('finds footwear by the everyday word and keeps one-letter sizes away from unsized items (minor 8)', () => {
    const oxfords = { name: 'Black Oxfords', category: 'Footwear', sizes: ['9', '10W'] }
    const belt = { name: 'Black Belt', category: 'Accessories', sizes: ['One size'] }
    const socks = { name: 'Black Socks', category: 'Footwear', sizes: ['M', 'L'] }
    const search = (query: string) => [oxfords, belt, socks].filter(item => matchesItemSearch(query, item)).map(item => item.name)
    expect(search('shoe')).toEqual(['Black Oxfords'])
    expect(search('shoes')).toEqual(['Black Oxfords'])
    expect(search('M')).toEqual(['Black Socks'])
    expect(search('m')).toEqual(['Black Socks'])
    expect(search('one size')).toEqual(['Black Belt'])
  })

  it('never treats built-in object keys as abbreviations', () => {
    expect(normalizeSearch('constructor toString')).toBe('constructor tostring')
    expect(matchesItemSearch('constructor', { name: 'PT Shorts' })).toBe(false)
  })
})
