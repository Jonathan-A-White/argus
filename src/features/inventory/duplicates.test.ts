import { describe, expect, it } from 'vitest'
import type { CatalogItemProjection } from '../../distributed/types'
import { GENESIS_CATALOG } from '../../stage3/domain'
import { describeDuplicate, findLikelyDuplicates, referenceKey } from './duplicates'

const catalog: CatalogItemProjection[] = GENESIS_CATALOG.map(item => (item.name === 'Black Oxfords' ? { ...item, niin: '8430-01-555-1234' } : item))
const names = (name: string, niin = '', excludeCatalogId?: string) => findLikelyDuplicates({ name, niin }, catalog, { excludeCatalogId }).map(match => `${match.item.name}: ${describeDuplicate(match)}`)

describe('likely duplicate catalog items', () => {
  it('matches names that differ only by case, punctuation, plural/singular or word order', () => {
    expect(names('black oxfords')).toEqual(['Black Oxfords: same name'])
    expect(names('Black Oxford')).toEqual(['Black Oxfords: same name'])
    expect(names('Shorts, PT')).toEqual(['PT Shorts: same name'])
    expect(names('pt-shorts')).toEqual(['PT Shorts: same name'])
    expect(names('SDB Jacket (Male)')).toEqual(['Male SDB Jacket: same name'])
  })

  it('expands common abbreviations before comparing', () => {
    expect(names('Blk Oxfords')).toEqual(['Black Oxfords: same name'])
    expect(names('Physical Training Shorts')).toEqual(['PT Shorts: same name'])
    expect(names('Male Service Dress Blue Jkt')).toEqual(['Male SDB Jacket: same name'])
    expect(names('Blk Slks')).toEqual(['Black Slacks: same name'])
    expect(names('Oxford Shoes, Black')).toEqual(['Black Oxfords: same name'])
  })

  it('matches the same NIIN, including an NSN written with its NIIN inside', () => {
    expect(names('Dress Shoes', '843001-555-1234')).toEqual(['Black Oxfords: same NIIN'])
    expect(names('Dress Shoes', '01-555-1234')).toEqual(['Black Oxfords: same NIIN'])
    expect(names('Black Oxfords', '8430015551234')).toEqual(['Black Oxfords: same name, same NIIN'])
    expect(referenceKey('N/A')).toBe('')
    expect(referenceKey('Not assigned')).toBe('')
  })

  it('warns about mostly overlapping words but keeps gender, colour and top/bottom variants distinct', () => {
    expect(names('Gold PT Shirts')).toEqual(['Gold PT Shirt: same name'])
    expect(names('PT Shirt')).toEqual(['Gold PT Shirt: similar name'])
    expect(names('Black Leather Oxfords')).toEqual(['Black Oxfords: similar name'])
    expect(names('Female SDB Jacket', '', GENESIS_CATALOG.find(item => item.name === 'Female SDB Jacket')!.catalogId)).toEqual([])
    expect(names('White Belt')).toEqual([])
    expect(names('Tracksuit Top')).toEqual(['Tracksuit Top: same name'])
    expect(names('Rifle Sling')).toEqual([])
    expect(names('')).toEqual([])
  })

  it('excludes the item being renamed and lists the strongest matches first', () => {
    const shorts = GENESIS_CATALOG.find(item => item.name === 'PT Shorts')!.catalogId
    expect(names('PT Shorts', '', shorts)).toEqual([])
    const extra: CatalogItemProjection = { ...GENESIS_CATALOG[0], catalogId: 'catalog:navy-pt-shorts', name: 'Navy PT Shorts', niin: '1234-5678' }
    const matches = findLikelyDuplicates({ name: 'PT Shorts', niin: '12345678' }, [...catalog, extra])
    expect(matches.map(match => [match.item.name, match.reasons])).toEqual([['PT Shorts', ['SAME_NAME']], ['Navy PT Shorts', ['SAME_NIIN', 'SIMILAR_NAME']]])
  })
})
