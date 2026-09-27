import type { CadetGender, NsLevel } from '../../distributed/types'
import { CADET_CODE_PATTERN } from '../../stage3/domain'

/** Exactly what DistributedAppController.importCadets accepts for one cadet. */
export type ImportRow = { gender: CadetGender; nsLevel: NsLevel; fullName?: string; cadetCode?: string }

/**
 * One pasted line after parsing. `fullName` is kept only so it can be handed to importCadets (which
 * encrypts it); the UI must never render it, only `hasName`.
 */
export type RosterRow = {
  line: number
  gender?: CadetGender
  nsLevel?: NsLevel
  /** Set only when the typed cadet ID is valid and free to use. */
  cadetCode?: string
  /** The typed cadet ID, normalized, when it has the cadet-ID shape (safe to display). */
  displayCode?: string
  /** Whether the line had a cadet ID at all (blank means one is generated). */
  codeProvided: boolean
  fullName?: string
  hasName: boolean
  errors: string[]
}

/** What the preview table may see of a row: everything except the name text. */
export type RosterPreview = Pick<RosterRow, 'line' | 'gender' | 'nsLevel' | 'displayCode' | 'codeProvided' | 'hasName' | 'errors'>

export const previewOf = ({ line, gender, nsLevel, displayCode, codeProvided, hasName, errors }: RosterRow): RosterPreview => ({ line, gender, nsLevel, displayCode, codeProvided, hasName, errors })

export type ParsedRoster ={ rows: RosterRow[]; headerSkipped: boolean; valid: ImportRow[]; invalidCount: number }

export const MAX_NAME_LENGTH = 120
export const MAX_PASTED_ROWS = 1000
export const MAX_QUICK_ADD = 500

const GENDERS: Record<string, CadetGender> = { m: 'Male', male: 'Male', f: 'Female', female: 'Female' }

export const parseGender = (value: string): CadetGender | undefined => GENDERS[value.trim().toLowerCase()]

export function parseLevel(value: string): NsLevel | undefined {
  const match = /^(?:ns)?\s*-?\s*([1-4])$/i.exec(value.trim())
  return match ? (`NS${match[1]}` as NsLevel) : undefined
}

/** A third column is a cadet ID only if it is written like one ("C-…"); anything else is a name. */
const looksLikeCode = (value: string) => /^c-\S*$/i.test(value.trim())

/** Tab-separated (spreadsheet paste), else comma-separated with "quoted, fields", else semicolons. */
export function splitRosterLine(line: string): string[] {
  if (line.includes('\t')) return line.split('\t').map(cell => cell.trim())
  if (!line.includes(',') && line.includes(';')) return line.split(';').map(cell => cell.trim())
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < line.length; index++) {
    const character = line[index]
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        cell += '"'
        index++
      } else if (character === '"') quoted = false
      else cell += character
    } else if (character === '"' && !cell.trim()) {
      quoted = true
      cell = ''
    } else if (character === ',') {
      cells.push(cell.trim())
      cell = ''
    } else cell += character
  }
  cells.push(cell.trim())
  return cells
}

const isHeader = (cells: string[]) => !parseGender(cells[0] ?? '') && (/gender|sex/i.test(cells[0] ?? '') || /level|grade/i.test(cells[1] ?? ''))

/**
 * Parses `gender,nsLevel[,cadetCode][,name]` lines. The header row is optional; gender accepts
 * M/F/Male/Female, level accepts NS1–NS4 or 1–4, and a blank cadet ID is generated on import.
 * Error messages never echo cell text, because a shifted column could put a name there.
 */
export function parseRoster(text: string, takenCodes: Iterable<string>): ParsedRoster {
  const taken = new Set(takenCodes)
  const seen = new Map<string, number>()
  const rows: RosterRow[] = []
  let headerSkipped = false
  const lines = text.split(/\r?\n/)
  for (const [index, raw] of lines.entries()) {
    if (!raw.trim()) continue
    const cells = splitRosterLine(raw)
    if (!rows.length && !headerSkipped && isHeader(cells)) {
      headerSkipped = true
      continue
    }
    const [genderCell = '', levelCell = '', ...rest] = cells
    const [third = '', ...others] = rest
    const codeCell = !third || looksLikeCode(third) ? third : ''
    const name = (!third || looksLikeCode(third) ? others : rest).filter(Boolean).join(', ').trim()
    const errors: string[] = []
    const gender = parseGender(genderCell)
    const nsLevel = parseLevel(levelCell)
    if (!gender) errors.push(genderCell ? 'Gender must be M, F, Male or Female.' : 'Gender is missing.')
    if (!nsLevel) errors.push(levelCell ? 'NS level must be NS1–NS4 or 1–4.' : 'NS level is missing.')
    const code = codeCell.trim().toUpperCase()
    let cadetCode: string | undefined
    if (code) {
      if (!CADET_CODE_PATTERN.test(code)) errors.push('Cadet IDs look like C-4F7K (C- then 4–6 letters or digits).')
      else if (taken.has(code)) errors.push(`Cadet ID ${code} is already in use.`)
      else if (seen.has(code)) errors.push(`Cadet ID ${code} is also on line ${seen.get(code)}.`)
      else cadetCode = code
      if (CADET_CODE_PATTERN.test(code) && !seen.has(code)) seen.set(code, index + 1)
    }
    if (name.length > MAX_NAME_LENGTH) errors.push(`Name is longer than ${MAX_NAME_LENGTH} characters.`)
    rows.push({
      line: index + 1,
      gender,
      nsLevel,
      cadetCode,
      ...(CADET_CODE_PATTERN.test(code) ? { displayCode: code } : {}),
      codeProvided: Boolean(code),
      ...(name ? { fullName: name } : {}),
      hasName: Boolean(name),
      errors,
    })
  }
  const valid = rows.flatMap(row => (row.errors.length || !row.gender || !row.nsLevel ? [] : [toImportRow(row)]))
  return { rows, headerSkipped, valid, invalidCount: rows.length - valid.length }
}

function toImportRow(row: RosterRow): ImportRow {
  return { gender: row.gender!, nsLevel: row.nsLevel!, ...(row.cadetCode ? { cadetCode: row.cadetCode } : {}), ...(row.fullName ? { fullName: row.fullName } : {}) }
}

/** The NCO helper: N nameless NS1 cadets, males first, with generated cadet IDs. */
export function quickClass(male: number, female: number): ImportRow[] {
  return [...Array.from({ length: male }, (): ImportRow => ({ gender: 'Male', nsLevel: 'NS1' })), ...Array.from({ length: female }, (): ImportRow => ({ gender: 'Female', nsLevel: 'NS1' }))]
}

/** Parses a head-count field: blank is 0; anything else must be a whole number from 0 to max. */
export function parseCount(value: string, max = MAX_QUICK_ADD): number | undefined {
  if (!value.trim()) return 0
  const count = Number(value)
  return Number.isInteger(count) && count >= 0 && count <= max ? count : undefined
}

export function chunk<T>(items: T[], size: number): T[][] {
  const parts: T[][] = []
  for (let index = 0; index < items.length; index += size) parts.push(items.slice(index, index + size))
  return parts
}

/** Removes the given 1-based line numbers (already imported) so a retry cannot import them twice. */
export function withoutLines(text: string, lines: Set<number>) {
  return text
    .split(/\r?\n/)
    .filter((_, index) => !lines.has(index + 1))
    .join('\n')
}

export const cadetCount = (count: number) => `${count} cadet${count === 1 ? '' : 's'}`
