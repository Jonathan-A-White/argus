/**
 * Size scheme presets transcribed from the NJROTC Supply Manual (Rev JUL 2023) size charts:
 * Table 2-6 (female coat: size + height), Table 2-7 (male coat: chest + length), Table 2-8
 * (unisex chest/bust ranges), Table 2-9 (cap) and Table 2-10 (glove). Trouser and footwear
 * presets follow standard issue nomenclature. They are only suggestions: supply staff pick the
 * sizes they actually stock and may add any custom size label.
 */
export type SizeScheme = { id: string; label: string; description: string; sizes: string[] }

const range = (from: number, to: number, step = 1) => { const values: number[] = []; for (let value = from; value <= to + 1e-9; value += step) values.push(Math.round(value * 1000) / 1000); return values }
const fraction = (value: number) => { const whole = Math.floor(value), rest = Math.round((value - whole) * 8); if (!rest) return String(whole); const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a; const divisor = gcd(rest, 8); return `${whole} ${rest / divisor}/${8 / divisor}` }

export const SIZE_SCHEMES: SizeScheme[] = [
  { id: 'unisex-alpha', label: 'Letter sizes (XS–3XL)', description: 'Supply Manual Table 2-8 unisex chest/bust ranges.', sizes: ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'] },
  { id: 'male-coat', label: 'Male coat (chest + length)', description: 'Supply Manual Table 2-7: chest size plus XS/S/R/L/XL/XXL length, e.g. 34R.', sizes: range(32, 56).flatMap(chest => ['XS', 'S', 'R', 'L', 'XL', 'XXL'].map(length => `${chest}${length}`)) },
  { id: 'female-coat', label: 'Female coat (size + height)', description: 'Supply Manual Table 2-6: J/M/W size plus XP/P/R/T/XT height, e.g. 6JP.', sizes: range(2, 26, 2).flatMap(size => ['J', 'M', 'W'].flatMap(fit => ['XP', 'P', 'R', 'T', 'XT'].map(height => `${size}${fit}${height}`))) },
  { id: 'cap', label: 'Cap size', description: 'Supply Manual Table 2-9: 6 1/2 through 8 1/2.', sizes: range(6.5, 8.5, 0.125).map(fraction) },
  { id: 'glove', label: 'Glove size', description: 'Supply Manual Table 2-10 (C = cadet, smaller).', sizes: ['5C', '6', '6C', '7', '7C', '8', '9', '10'] },
  { id: 'trouser', label: 'Trousers / slacks (waist + length)', description: 'Waist in inches plus S/R/L length, e.g. 32R.', sizes: range(24, 46, 2).flatMap(waist => ['S', 'R', 'L'].map(length => `${waist}${length}`)) },
  { id: 'shirt-neck', label: 'Dress shirt (neck)', description: 'Neck size in inches.', sizes: range(13, 19, 0.5).map(value => value % 1 ? `${Math.floor(value)} 1/2` : String(value)) },
  { id: 'shoe-men', label: "Men's shoes (size + width)", description: 'Half sizes 5–15 in N/M/W widths, e.g. 10M.', sizes: range(5, 15, 0.5).flatMap(size => ['N', 'M', 'W'].map(width => `${size}${width}`)) },
  { id: 'shoe-women', label: "Women's shoes (size + width)", description: 'Half sizes 4–12 in N/M/W widths, e.g. 7.5M.', sizes: range(4, 12, 0.5).flatMap(size => ['N', 'M', 'W'].map(width => `${size}${width}`)) },
]

export const sizeScheme = (id?: string) => SIZE_SCHEMES.find(scheme => scheme.id === id)

/** A size label is free text but bounded and trimmed so it stays readable on phones and in bundle snapshots. */
export function normalizeSizeLabel(value: string) {
  const label = value.trim().replace(/\s+/g, ' ')
  if (!label || label.length > 24) throw new Error('Size labels must be 1–24 characters.')
  return label
}
