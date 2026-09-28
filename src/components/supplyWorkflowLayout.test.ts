import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Read from disk: Vitest replaces CSS imports with empty modules.
const styles = readFileSync(join(import.meta.dirname, '..', 'styles.css'), 'utf8')

/**
 * jsdom has no layout, so the sticky workflow footer's geometry is checked in the browser (Playwright). This guards the CSS
 * contract that geometry depends on: the footer's sticky offset and the workflow drawer's bottom padding are the same
 * number on every screen width. A phone-only ".demo-drawer{padding:18px 16px}" once shrank the padding to 18px while the
 * footer kept "bottom:-92px", so mid-scroll the Back / Review buttons sat 74px below the screen.
 */
const css = styles.replaceAll(/\/\*[\s\S]*?\*\//g, '')
const declarations = (selector: string) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selectors]) => selectors.split(',').map(value => value.trim()).includes(selector))
    .flatMap(([, , body]) => body.split(';').map(part => part.trim()).filter(Boolean))

describe('issue/return workflow footer layout (CSS contract)', () => {
  it('derives the footer offsets and the drawer padding from one custom property', () => {
    expect(declarations('.supply-workflow')).toContain('--workflow-footer-space:92px')
    // Two classes, so the phone rule ".demo-drawer{padding:…}" cannot override it.
    expect(declarations('.demo-drawer.supply-workflow')).toContain('padding-bottom:var(--workflow-footer-space)')
    expect(declarations('.supply-workflow').some(value => value.startsWith('padding'))).toBe(false)
    const footer = declarations('.sticky-workflow')
    const bottoms = footer.filter(value => value.startsWith('bottom:'))
    expect(bottoms).toEqual(['bottom:calc(-1 * var(--workflow-footer-space))'])
    // Every bottom margin of the footer (longhand, or the third value of the shorthand) follows the same property.
    const marginBottoms = footer.flatMap(value => {
      if (value.startsWith('margin-bottom:')) return [value.slice('margin-bottom:'.length)]
      if (!value.startsWith('margin:')) return []
      const parts = value.slice('margin:'.length).match(/calc\([^)]*\)|\S+/g) ?? []
      return [parts[2] ?? parts[0]]
    })
    expect(marginBottoms.length).toBeGreaterThan(0)
    for (const margin of marginBottoms) expect(margin).toContain('var(--workflow-footer-space)')
  })

  it('keeps focused fields clear of the stuck footer', () => {
    expect(declarations('.demo-drawer.supply-workflow').some(value => value.startsWith('scroll-padding-bottom:'))).toBe(true)
  })
})
