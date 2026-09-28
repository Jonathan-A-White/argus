import { describe, expect, it } from 'vitest'
import type { CatalogItemProjection, InventoryProjection } from '../../distributed/types'
import { catalogStatus } from './catalogModel'

const item = { catalogId: 'c-shorts', name: 'PT Shorts', category: 'PT', sized: true, active: true } as CatalogItemProjection
const size = (variant: string, onHand: number, extra: Partial<InventoryProjection> = {}) => ({ entityId: `c-shorts:${variant}`, catalogId: 'c-shorts', name: 'PT Shorts', category: 'PT', variant, niin: '', onHand, issued: 0, countIncrement: 1, active: true, version: 1, appliedEventIds: [], ...extra }) as InventoryProjection

describe('catalog item status badge (minor 1)', () => {
  it('says how many sizes are out when others still have stock', () => {
    expect(catalogStatus(item, [size('S', 0, { reorderAt: 2 }), size('M', 5), size('L', 3)])).toEqual({ label: '1 size out', tone: 'warning' })
    expect(catalogStatus(item, [size('S', 0, { reorderAt: 2 }), size('M', 0, { issued: 2 }), size('L', 3)])).toEqual({ label: '2 sizes out', tone: 'warning' })
  })

  it('keeps "Out of stock" for an item with nothing left in any size', () => {
    expect(catalogStatus(item, [size('S', 0, { reorderAt: 2 }), size('M', 0, { issued: 1 })])).toEqual({ label: 'Out of stock', tone: 'danger' })
    expect(catalogStatus(item, [size('S', 0), size('M', 0)])).toEqual({ label: 'Nothing on hand', tone: 'neutral' })
    expect(catalogStatus(item, [size('S', 1, { reorderAt: 2 }), size('M', 5)])).toEqual({ label: 'Low stock', tone: 'warning' })
  })
})
