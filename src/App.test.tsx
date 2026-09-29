import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { FakeChain } from './chain/fakeChain'
import { MemoryWalletStateStore } from './chain/walletStore'
import { DistributedAppController } from './distributed/appIntegration'
import { MemoryRepository } from './storage/repository'
import { DEFAULT_SETTINGS, LocalSettingsStorage, SETTINGS_KEY } from './settings'
import { MemoryLedgerStore } from './unit/ledgerStore'
import { createJoiningDevice, encodeJoinRequest, loadDeviceVault } from './unit/vault'

const memoryStorage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), removeItem: (key: string) => void values.delete(key), values } }
const PASS = 'supply closet 42'
/** Home is the dashboard (no taskbar, spec §5); elsewhere the primary navigation is shown. */
async function goTo(label: 'Count' | 'Inventory' | 'Cadets' | 'Calendar' | 'Activity' | 'More') {
  const primary = screen.queryByRole('navigation', { name: 'Primary navigation' })
  if (primary) { fireEvent.click(within(primary).getByRole('button', { name: label })); return }
  const tiles = await screen.findByRole('navigation', { name: 'Dashboard navigation' })
  fireEvent.click(within(tiles).getByRole('button', { name: new RegExp(label === 'More' ? 'Command Center' : label) }))
}
const runtimeOptions = (chain: FakeChain) => ({ api: chain, ledger: new MemoryLedgerStore(), walletStore: new MemoryWalletStateStore() })

async function createUnitThroughUi(chain: FakeChain, storage = memoryStorage()) {
  render(<App runtimeOptions={runtimeOptions(chain)} storage={storage} settingsStorage={new LocalSettingsStorage(memoryStorage())} />)
  fireEvent.click(await screen.findByRole('button', { name: /Create a new unit/ }))
  fireEvent.change(screen.getByLabelText('Unit name'), { target: { value: 'Bethel NJROTC' } })
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Chief' } })
  fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: PASS } })
  fireEvent.change(screen.getByLabelText('Confirm passphrase'), { target: { value: PASS } })
  fireEvent.click(screen.getByRole('button', { name: 'Create unit' }))
  await screen.findByRole('button', { name: /Signed in as/ }, { timeout: 20_000 })
  return storage
}

describe('application shell', { timeout: 60_000 }, () => {
  it('shows hydration first, then a clearly labelled mock demo with no placeholder data', async () => {
    const controller = new DistributedAppController(new MemoryRepository())
    render(<App controller={controller} settingsStorage={new LocalSettingsStorage(memoryStorage())} />)
    expect(screen.getByText('Loading A.R.G.U.S.…')).toBeInTheDocument()
    expect(await screen.findByText('MOCK BLOCKCHAIN')).toBeInTheDocument()
    expect(screen.getByText('Development Environment · No Production Transactions')).toBeInTheDocument()
    expect(screen.queryByText('BSV TESTNET')).not.toBeInTheDocument()
    expect(screen.getAllByText('MOCK · THIS DEVICE ONLY').length).toBeGreaterThan(0)
  })

  it('lands on the dashboard without a taskbar, and shows full navigation everywhere else', async () => {
    render(<App controller={new DistributedAppController(new MemoryRepository())} settingsStorage={new LocalSettingsStorage(memoryStorage())} />)
    expect(await screen.findByRole('heading', { name: 'Home', level: 1 })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Primary navigation' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Quick actions' })).toBeInTheDocument()
    await goTo('Inventory')
    expect(await screen.findByRole('heading', { name: 'Inventory', level: 1 })).toBeInTheDocument()
    for (const label of ['Home', 'Count', 'Inventory', 'Cadets', 'Calendar', 'Activity', 'More']) expect(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: label })).toBeInTheDocument()
    for (const label of ['Home', 'Count', 'Inventory', 'Cadets', 'More']) expect(within(screen.getByRole('navigation', { name: 'Mobile navigation' })).getByRole('button', { name: label })).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Calendar' }))
    expect(await screen.findByRole('heading', { name: 'Supply Calendar', level: 1 })).toBeInTheDocument()
    await goTo('More')
    expect(await screen.findByRole('heading', { name: 'Command Center', level: 1 })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Diagnostics/ }))
    expect(await screen.findByText('Data integrity healthy')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }))
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Mobile navigation' })).getByRole('button', { name: 'Home' }))
    expect(await screen.findByRole('navigation', { name: 'Dashboard navigation' })).toBeInTheDocument()
  })

  it('opens the issue workflow straight from the dashboard quick action', async () => {
    render(<App controller={new DistributedAppController(new MemoryRepository())} settingsStorage={new LocalSettingsStorage(memoryStorage())} />)
    const actions = await screen.findByRole('region', { name: 'Quick actions' })
    fireEvent.click(within(actions).getByRole('button', { name: /issue/i }))
    expect(await screen.findByRole('dialog', { name: 'Issue property' })).toBeInTheDocument()
  })

  it('persists personal preferences and applies the theme immediately', async () => {
    const preferenceStorage = memoryStorage()
    const view = render(<App controller={new DistributedAppController(new MemoryRepository())} settingsStorage={new LocalSettingsStorage(preferenceStorage)} />)
    fireEvent.click(await screen.findByLabelText('Settings'))
    fireEvent.change(screen.getByLabelText('Appearance'), { target: { value: 'light' } })
    fireEvent.change(screen.getByLabelText('Default section'), { target: { value: 'inventory' } })
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'))
    expect(JSON.parse(preferenceStorage.values.get(SETTINGS_KEY)!)).toMatchObject({ ...DEFAULT_SETTINGS, theme: 'light', defaultSection: 'inventory' })
    view.unmount()
    render(<App controller={new DistributedAppController(new MemoryRepository())} settingsStorage={new LocalSettingsStorage(preferenceStorage)} />)
    expect(await screen.findByRole('heading', { name: 'Inventory', level: 1 })).toBeInTheDocument()
  })

  it('never shows a cadet name in the activity log; cadets appear by cadet ID', async () => {
    const controller = new DistributedAppController(new MemoryRepository())
    await controller.initialize()
    const projection = await controller.createCadet({ gender: 'Female', nsLevel: 'NS1', status: 'ACTIVE', fullName: 'Very Private Name' })
    render(<App controller={controller} settingsStorage={new LocalSettingsStorage(memoryStorage())} />)
    await goTo('Activity')
    expect(await screen.findByText(`Added cadet ${projection.cadets[0].cadetCode}`)).toBeInTheDocument()
    expect(screen.queryByText(/Very Private Name/)).not.toBeInTheDocument()
  })
})

describe('unit onboarding over a (fake) BSV testnet chain', { timeout: 120_000 }, () => {
  it('shows the testnet safety banner before sign-in too (spec §30), and offers restoring a Master from a recovery file', async () => {
    render(<App runtimeOptions={runtimeOptions(new FakeChain())} storage={memoryStorage()} settingsStorage={new LocalSettingsStorage(memoryStorage())} />)
    expect(await screen.findByText('BSV TESTNET')).toBeInTheDocument()
    expect(screen.getByText('Development Environment · No Production Transactions')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Restore Master from a recovery file/ }))
    expect(await screen.findByRole('form', { name: 'Restore Master from a recovery file' })).toBeInTheDocument()
    expect(screen.getByText('BSV TESTNET')).toBeInTheDocument()
  })

  it('creates a unit, shows the real person and role, and refuses mismatched passphrases', async () => {
    const chain = new FakeChain(), storage = memoryStorage()
    render(<App runtimeOptions={runtimeOptions(chain)} storage={storage} settingsStorage={new LocalSettingsStorage(memoryStorage())} />)
    fireEvent.click(await screen.findByRole('button', { name: /Create a new unit/ }))
    fireEvent.change(screen.getByLabelText('Unit name'), { target: { value: 'Bethel NJROTC' } })
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Chief' } })
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: PASS } })
    fireEvent.change(screen.getByLabelText('Confirm passphrase'), { target: { value: 'different pass 1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create unit' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('do not match')
    fireEvent.change(screen.getByLabelText('Confirm passphrase'), { target: { value: PASS } })
    fireEvent.click(screen.getByRole('button', { name: 'Create unit' }))
    expect(await screen.findByRole('button', { name: /Signed in as/ }, { timeout: 20_000 })).toBeInTheDocument()
    expect(screen.getAllByText('Chief').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Master').length).toBeGreaterThan(0)
    expect(loadDeviceVault(storage)?.unit?.unitName).toBe('Bethel NJROTC')
  })

  it('the Master admits a person from their join code; the joiner enters the admission code and is in the same unit', async () => {
    const chain = new FakeChain()
    const masterStorage = await createUnitThroughUi(chain)
    chain.fund(loadDeviceVault(masterStorage)!.walletAddress, 100_000, { confirmed: true })
    // The joiner's device (created with the same code the UI's Join flow uses).
    const joinerStorage = memoryStorage()
    const joiner = await createJoiningDevice({ passphrase: 'another pass 77', displayName: 'Jordan' }, joinerStorage)
    await goTo('More')
    fireEvent.click(await screen.findByRole('button', { name: /Members & access/ }))
    fireEvent.change(screen.getByLabelText('Join code'), { target: { value: await encodeJoinRequest(joiner) } })
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'SUPPLY_OFFICER' } })
    fireEvent.click(screen.getByRole('button', { name: 'Admit' }))
    const code = (await screen.findByLabelText('Admission code', {}, { timeout: 20_000 }) as HTMLTextAreaElement).value
    expect(code).toMatch(/^ARGUS-ADMIT-1:/)
    expect(await screen.findByRole('img', { name: /One-time admission QR code for Jordan/ })).toHaveAttribute('src', expect.stringMatching(/^data:image\/png;base64,/))
    expect(screen.getByRole('button', { name: 'Share QR image' })).toBeInTheDocument()
    expect(await screen.findByText('view transaction', {}, { timeout: 20_000 })).toBeInTheDocument()
    // The member list refreshes after the admission code appears, so wait for it rather than reading it synchronously.
    const people = screen.getByRole('list', { name: 'People in this unit' })
    expect(await within(people).findByText(/Jordan/, {}, { timeout: 20_000 })).toBeInTheDocument()

    // On the joiner's device: unlock, see the waiting screen with a join code, paste the admission code.
    document.body.innerHTML = ''
    render(<App runtimeOptions={runtimeOptions(chain)} storage={joinerStorage} settingsStorage={new LocalSettingsStorage(memoryStorage())} />)
    fireEvent.change(await screen.findByLabelText('Passphrase'), { target: { value: 'another pass 77' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    // The code is derived asynchronously after the screen appears; wait for it rather than reading the empty box.
    const joinCodeBox = await screen.findByLabelText('Your join code', {}, { timeout: 20_000 }) as HTMLTextAreaElement
    await waitFor(() => expect(joinCodeBox.value).toMatch(/^ARGUS-JOIN-1:/), { timeout: 20_000 })
    fireEvent.change(screen.getByLabelText('Admission code'), { target: { value: code } })
    fireEvent.click(screen.getByRole('button', { name: 'Join unit' }))
    expect(await screen.findByRole('button', { name: /Signed in as/ }, { timeout: 20_000 })).toBeInTheDocument()
    expect(screen.getAllByText('Supply Officer').length).toBeGreaterThan(0)
    expect(loadDeviceVault(joinerStorage)?.unit?.unitId).toBe(loadDeviceVault(masterStorage)?.unit?.unitId)
  })

  it('locks back to the unlock screen and rejects a wrong passphrase', async () => {
    const chain = new FakeChain()
    await createUnitThroughUi(chain)
    await goTo('More')
    fireEvent.click(await screen.findByRole('button', { name: /Lock this device/ }))
    fireEvent.change(await screen.findByLabelText('Passphrase'), { target: { value: 'wrong passphrase 9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    expect(await screen.findByRole('alert', {}, { timeout: 20_000 })).toHaveTextContent('not correct')
  })
})

describe('mock-development demo (M6)', { timeout: 60_000 }, () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
  afterEach(() => {
    vi.unstubAllEnvs()
    if (original) Object.defineProperty(globalThis, 'indexedDB', original)
    else Reflect.deleteProperty(globalThis, 'indexedDB')
  })

  it('keeps what was recorded when the page is reloaded', async () => {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() })
    vi.stubEnv('VITE_ARGUS_BLOCKCHAIN_MODE', 'mock-development')
    const first = render(<App settingsStorage={new LocalSettingsStorage(memoryStorage())} />)
    expect(await screen.findByText('MOCK BLOCKCHAIN')).toBeInTheDocument()
    await goTo('Cadets')
    fireEvent.click(await screen.findByRole('button', { name: 'Add cadet' }))
    const form = screen.getByRole('form', { name: 'Add cadet' })
    fireEvent.change(within(form).getByLabelText('Cadet ID (optional)'), { target: { value: 'C-DM34' } })
    fireEvent.change(within(form).getByLabelText('Gender'), { target: { value: 'Male' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Add cadet' }))
    expect(await screen.findByText('C-DM34', { selector: 'b, strong' })).toBeInTheDocument()
    first.unmount()

    // A reload: a fresh app and controller over the same browser storage.
    render(<App settingsStorage={new LocalSettingsStorage(memoryStorage())} />)
    await goTo('Cadets')
    expect(await screen.findByText('C-DM34', { selector: 'b, strong' })).toBeInTheDocument()
  })
})
