import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
/** Elements outside every dialog that stay usable (the toast announces results of what a dialog did). */
const KEEP_ACTIVE = '[data-modal-keep]'

/** Open dialogs, innermost last: only the top one answers Escape and keeps Tab inside itself. */
const stack: HTMLElement[] = []

const visible = (element: HTMLElement) => typeof element.checkVisibility !== 'function' || element.checkVisibility()
const focusables = (dialog: HTMLElement) => [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(element => !element.closest('[inert]') && visible(element))

/** Makes everything except `node` (and its ancestors) inert; returns the undo. Elements already inert are left alone, so nested dialogs undo in order. */
function inertOutside(node: HTMLElement) {
  const changed: HTMLElement[] = []
  for (let current: HTMLElement | null = node; current && current !== document.body; current = current.parentElement) {
    for (const sibling of current.parentElement?.children ?? []) {
      if (sibling === current || !(sibling instanceof HTMLElement) || sibling.hasAttribute('inert') || sibling.matches(KEEP_ACTIVE) || sibling.tagName === 'SCRIPT') continue
      sibling.setAttribute('inert', '')
      changed.push(sibling)
    }
  }
  return () => { for (const element of changed) element.removeAttribute('inert') }
}

/**
 * Modal behaviour shared by every drawer: focus moves into the dialog when it opens (unless a
 * field inside already took it), Tab and Shift+Tab stay inside, the rest of the page is inert,
 * Escape closes the top dialog, and focus returns to whatever opened it.
 */
export function useModalDialog(dialogRef: RefObject<HTMLElement | null>, close: () => void) {
  const closeRef = useRef(close)
  useEffect(() => { closeRef.current = close }, [close])
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const backdrop = dialog.parentElement ?? dialog
    stack.push(dialog)
    const undoInert = inertOutside(backdrop)
    if (!dialog.contains(document.activeElement)) dialog.focus({ preventScroll: true })
    const onKeyDown = (event: KeyboardEvent) => {
      if (stack.at(-1) !== dialog || event.defaultPrevented) return
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return }
      if (event.key !== 'Tab') return
      const items = focusables(dialog), first = items[0], last = items.at(-1), active = document.activeElement
      if (!first || !last) { event.preventDefault(); dialog.focus(); return }
      const outside = !dialog.contains(active) || active === dialog
      if (event.shiftKey && (outside || active === first)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (outside || active === last)) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      const index = stack.lastIndexOf(dialog)
      if (index >= 0) stack.splice(index, 1)
      undoInert()
      if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true })
    }
  }, [dialogRef])
}
