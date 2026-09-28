import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Drawer } from './Drawer'

/** A page with a background, an opener and a drawer that can open a second drawer on top of it. */
function Page() {
  const [open, setOpen] = useState(false), [nested, setNested] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>Open panel</button>
      <main><button>Background action</button></main>
      {open && (
        <Drawer title="Test panel" icon={null} close={() => setOpen(false)}>
          <input aria-label="First field" />
          <button onClick={() => setNested(true)}>Open details</button>
          {nested && <Drawer title="Details" icon={null} close={() => setNested(false)}><button>Inner action</button></Drawer>}
        </Drawer>
      )}
    </>
  )
}

const tab = (shift = false) => fireEvent.keyDown(document, { key: 'Tab', shiftKey: shift })

describe('Drawer focus management (M7)', () => {
  it('moves focus in, keeps Tab inside, makes the page inert, and returns focus to the opener', () => {
    render(<Page />)
    const opener = screen.getByRole('button', { name: 'Open panel' })
    opener.focus()
    fireEvent.click(opener)
    const dialog = screen.getByRole('dialog', { name: 'Test panel' })
    expect(dialog).toHaveFocus()
    // Everything behind the drawer is inert (not clickable, not focusable, hidden from assistive tech).
    expect(screen.getByRole('button', { name: 'Background action' }).closest('[inert]')).not.toBeNull()
    expect(opener).toHaveAttribute('inert')
    expect(dialog.closest('[inert]')).toBeNull()

    // Tab wraps from the last control to the first (the close button) and Shift+Tab back again.
    const close = screen.getByRole('button', { name: 'Close panel' }), last = screen.getByRole('button', { name: 'Open details' })
    last.focus(); tab()
    expect(close).toHaveFocus()
    tab(true)
    expect(last).toHaveFocus()
    // From the dialog itself (as it is right after opening), Shift+Tab goes to the last control.
    dialog.focus(); tab(true)
    expect(last).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(opener).toHaveFocus()
    expect(document.querySelector('[inert]')).toBeNull()
  })

  it('Escape closes only the top drawer of a stack, and each close returns focus one level down', () => {
    render(<Page />)
    fireEvent.click(screen.getByRole('button', { name: 'Open panel' }))
    const details = screen.getByRole('button', { name: 'Open details' })
    details.focus()
    fireEvent.click(details)
    expect(screen.getByRole('dialog', { name: 'Details' })).toHaveFocus()
    // Only the inner drawer answers Tab now.
    screen.getByRole('button', { name: 'Inner action' }).focus(); tab()
    expect(screen.getAllByRole('button', { name: 'Close panel' })[1]).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Details' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Test panel' })).toBeInTheDocument()
    expect(details).toHaveFocus()
    expect(details.closest('[inert]')).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes on a backdrop click but not on a click inside the panel', () => {
    render(<Page />)
    fireEvent.click(screen.getByRole('button', { name: 'Open panel' }))
    const dialog = screen.getByRole('dialog', { name: 'Test panel' })
    fireEvent.mouseDown(screen.getByLabelText('First field'))
    expect(dialog).toBeInTheDocument()
    fireEvent.mouseDown(dialog.parentElement!)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
