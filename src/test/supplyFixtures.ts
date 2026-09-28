import { DistributedAppController, type ArgusAppProjection } from '../distributed/appIntegration'
import { GENESIS_CATALOG, oneSizeVariantId } from '../stage3/domain'

/** Test helpers for readiness scenarios: a single-device demo unit with genesis catalog and factory bundles. */
export const DAY = 86_400_000
export const catalogId = (name: string) => GENESIS_CATALOG.find(item => item.name === name)!.catalogId
export const oneSize = (name: string) => oneSizeVariantId(catalogId(name))

export async function demoUnit() {
  const controller = new DistributedAppController()
  const projection = await controller.initialize()
  return { controller, projection }
}

/** Adds the given sizes to a sized genesis item and receives the quantities; returns each size's item ID. */
export async function stockSizes(controller: DistributedAppController, name: string, sizes: Record<string, number>) {
  let projection = await controller.addCatalogSizes(catalogId(name), Object.keys(sizes))
  const ids: Record<string, string> = {}
  for (const [size, quantity] of Object.entries(sizes)) {
    const item = projection.inventory.find(candidate => candidate.catalogId === catalogId(name) && candidate.variant === size)!
    ids[size] = item.entityId
    if (quantity) projection = await controller.receiveStock(item.entityId, quantity)
  }
  return { projection, ids }
}

export const cadetByCode = (projection: ArgusAppProjection, code: string) => projection.cadets.find(cadet => cadet.cadetCode === code)!
