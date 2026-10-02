import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { DistributedAppController } from '../../distributed/appIntegration'
import { buildExportSheets, createWorkbook, exportFilename } from './exportModel'

async function projection() {
  const controller = new DistributedAppController()
  await controller.initialize()
  await controller.createInventoryItem({ name: '=PT Shirt', category: 'PT', variant: 'M', niin: '', onHand: 5, countIncrement: 1, active: true })
  const withCadet = await controller.createCadet({ fullName: '+Jordan Rivera', gender: 'Male', nsLevel: 'NS2', status: 'ACTIVE', cadetCode: 'C-JR34' })
  const cadet = withCadet.cadets.find(value => value.cadetCode === 'C-JR34')!
  const item = withCadet.inventory.find(value => value.name === '=PT Shirt')!
  return controller.issueTransaction({ transactionId: 'tx-export', cadetId: cadet.cadetId, lines: [{ lineId: 'line-1', itemId: item.entityId, quantity: 2 }] }, { timestamp: '2026-10-01T12:00:00.000Z' })
}

describe('unit spreadsheet export', () => {
  it('builds complete human-readable sheets and protects user text from formulas', async () => {
    const report = buildExportSheets(await projection(), new Date('2026-10-02T10:30:00.000Z'))
    expect(report.map(sheet => sheet.name)).toEqual(['Cadets', 'Cadet Property', 'Inventory', 'Still Needed', 'Report Information'])
    expect(report[0].rows[1]).toEqual(expect.arrayContaining(["'+Jordan Rivera", 'Male', 'NS2', 'Active', 2]))
    expect(report[1].rows[1]).toEqual(expect.arrayContaining(["'+Jordan Rivera", "'=PT Shirt", 'M', 2, '2026-10-01']))
    expect(report[2].rows.find(row => row.includes("'=PT Shirt"))).toEqual(expect.arrayContaining([3, 2, 5]))
    expect(report.flatMap(sheet => sheet.rows).flat()).not.toContain('C-JR34')
  })

  it('creates a valid Open XML workbook package with every worksheet', async () => {
    const bytes = createWorkbook(await projection(), new Date('2026-10-02T10:30:00.000Z'))
    const files = unzipSync(bytes)
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet5.xml']))
    expect(strFromU8(files['xl/workbook.xml'])).toContain('Cadet Property')
    expect(strFromU8(files['xl/worksheets/sheet1.xml'])).toContain('+Jordan Rivera')
    expect(exportFilename(new Date('2026-10-02T10:30:00.000Z'))).toBe('ARGUS Unit Supply 2026-10-02.xlsx')
  })
})
