import { strToU8, zipSync } from 'fflate'
import type { ArgusAppProjection } from '../../distributed/appIntegration'
import { inventoryStatuses } from '../../stage3/inventoryStatus'

export type ExportCell = string | number
export type ExportSheet = { name: string; rows: ExportCell[][]; widths: number[] }

const safeText = (value: string) => /^[=+\-@]/.test(value) ? `'${value}` : value
const nameOf = (cadet: Pick<ArgusAppProjection['cadets'][number], 'fullName'>) => cadet.fullName.trim() || 'Name not entered'
const byText = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
const displayDate = (value?: string) => value ? value.slice(0, 10) : ''

export function buildExportSheets(projection: ArgusAppProjection, generatedAt = new Date()): ExportSheet[] {
  const cadets = [...projection.cadets].sort((a, b) => byText(nameOf(a), nameOf(b)) || byText(a.cadetId, b.cadetId))
  const bundleNames = new Map(projection.bundles.map(bundle => [bundle.bundleId, bundle.versions.find(version => version.version === bundle.currentVersion)?.displayName ?? '']))
  const openNeeds = projection.stillNeeded.filter(need => need.status === 'OPEN' || need.status === 'PARTIALLY_FULFILLED')
  const propertySummary = (cadet: typeof cadets[number]) => [...cadet.currentProperty]
    .sort((a, b) => byText(`${a.label} ${a.variant}`, `${b.label} ${b.variant}`))
    .map(line => `${line.label} — ${line.variant} (${line.quantity})`).join('; ')
  const needsSummary = (cadet: typeof cadets[number]) => openNeeds.filter(need => need.cadetId === cadet.cadetId)
    .sort((a, b) => byText(a.displayLabel, b.displayLabel))
    .map(need => `${need.displayLabel}${need.size ? ` — ${need.size}` : ''} (${need.quantityNeeded - need.quantityFulfilled})`).join('; ')

  const statuses = inventoryStatuses(projection.inventory, projection, generatedAt)
  const statusById = new Map([...statuses.values()].map(status => [status.itemId, status.labels.join(', ')]))
  const inventory = [...projection.inventory].sort((a, b) => byText(`${a.category} ${a.name} ${a.variant}`, `${b.category} ${b.name} ${b.variant}`))

  return [
    { name: 'Cadets', widths: [28, 12, 12, 12, 16, 60, 60, 18], rows: [
      ['Cadet Name', 'Gender', 'NS Level', 'Status', 'Total Items Issued', 'Property Summary', 'Still Needed', 'Profile Review'],
      ...cadets.map(cadet => [safeText(nameOf(cadet)), cadet.gender, cadet.nsLevel, cadet.status === 'ACTIVE' ? 'Active' : 'Inactive', cadet.propertyCount, safeText(propertySummary(cadet)), safeText(needsSummary(cadet)), cadet.profileNeedsReview ? 'Needs review' : 'Complete']),
    ] },
    { name: 'Cadet Property', widths: [28, 12, 12, 28, 18, 12, 14, 24], rows: [
      ['Cadet Name', 'Gender', 'NS Level', 'Item', 'Size', 'Quantity', 'Issued Date', 'Bundle'],
      ...cadets.flatMap(cadet => [...cadet.currentProperty].sort((a, b) => byText(`${a.label} ${a.variant}`, `${b.label} ${b.variant}`)).map(line => [safeText(nameOf(cadet)), cadet.gender, cadet.nsLevel, safeText(line.label), safeText(line.variant), line.quantity, displayDate(line.issuedAt), safeText(line.bundleId ? bundleNames.get(line.bundleId) ?? '' : '')])),
    ] },
    { name: 'Inventory', widths: [20, 28, 18, 12, 12, 18, 15, 34, 14], rows: [
      ['Category', 'Item', 'Size', 'On Hand', 'Issued', 'Total Accountable', 'Reorder Level', 'Status', 'Last Counted'],
      ...inventory.map(item => [safeText(item.category), safeText(item.name), safeText(item.variant), item.onHand, item.issued, item.onHand + item.issued, item.reorderAt ?? '', statusById.get(item.entityId) ?? '', displayDate(item.lastCountedAt)]),
    ] },
    { name: 'Still Needed', widths: [28, 12, 12, 28, 18, 18, 16, 22], rows: [
      ['Cadet Name', 'Gender', 'NS Level', 'Item', 'Size', 'Quantity Needed', 'Availability', 'Status'],
      ...openNeeds.map(need => { const cadet = cadets.find(candidate => candidate.cadetId === need.cadetId); return [safeText(cadet ? nameOf(cadet) : 'Cadet record unavailable'), cadet?.gender ?? '', cadet?.nsLevel ?? '', safeText(need.displayLabel), safeText(need.size ?? ''), need.quantityNeeded - need.quantityFulfilled, need.availability.available ? 'Available' : need.availability.configured ? 'Not enough on hand' : 'Not configured', need.status === 'PARTIALLY_FULFILLED' ? 'Partially fulfilled' : 'Open'] }),
    ] },
    { name: 'Report Information', widths: [30, 55], rows: [
      ['Report', 'A.R.G.U.S. Unit Supply'], ['Generated', generatedAt.toISOString()], ['Cadets', cadets.length], ['Active Cadets', cadets.filter(cadet => cadet.status === 'ACTIVE').length], ['Inactive Cadets', cadets.filter(cadet => cadet.status === 'INACTIVE').length], ['Current Property Lines', cadets.reduce((sum, cadet) => sum + cadet.currentProperty.length, 0)], ['Records Waiting to Sync', projection.sync.outbox], ['Open Conflicts', projection.sync.openConflicts], ['Rejected Records', projection.rejected.length], ['Data Integrity', projection.integrity.healthy ? 'Healthy' : 'Needs attention'], ['Notice', 'Sensitive cadet supply record. Store and share only with authorized personnel.'],
    ] },
  ]
}

const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
const column = (index: number) => { let value = index + 1, out = ''; while (value) { value--; out = String.fromCharCode(65 + value % 26) + out; value = Math.floor(value / 26) } return out }
const worksheet = (sheet: ExportSheet) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${sheet.widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${sheet.rows.map((row, rowIndex) => `<row r="${rowIndex + 1}"${rowIndex === 0 ? ' s="1" customFormat="1"' : ''}>${row.map((cell, cellIndex) => typeof cell === 'number' ? `<c r="${column(cellIndex)}${rowIndex + 1}"><v>${cell}</v></c>` : `<c r="${column(cellIndex)}${rowIndex + 1}" t="inlineStr"><is><t xml:space="preserve">${xml(cell)}</t></is></c>`).join('')}</row>`).join('')}</sheetData><autoFilter ref="A1:${column(sheet.rows[0].length - 1)}${Math.max(1, sheet.rows.length)}"/></worksheet>`

export function createWorkbook(projection: ArgusAppProjection, generatedAt = new Date()) {
  const sheets = buildExportSheets(projection, generatedAt)
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, i) => `<sheet name="${xml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'xl/styles.xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF17324D"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>'),
  }
  sheets.forEach((sheet, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(worksheet(sheet)) })
  return zipSync(files, { level: 6 })
}

export function exportFilename(generatedAt = new Date()) { return `ARGUS Unit Supply ${generatedAt.toISOString().slice(0, 10)}.xlsx` }
