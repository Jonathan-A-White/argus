import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
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
const runtimeOptions = (chain: FakeChain) => ({ api: chain, ledger: new MemoryLedgerStore(), walletStore: new MemoryWalletStateStore() })

async function createUnitThroughUi(chain: FakeChain, storage = memoryStorage()) {
  render(<App runtimeOptions={runtimeOptions(chain)} storage={storage} settingsStorage={new LocalSettingsStorage(memoryStorage())} />)
  fireEvent.click(await screen.findByRole('button', { name: /Create a new unit/ }))
  fireEvent.change(screen.getByLabelText('Unit name'), { target: { value: 'Bethel NJROTC' } })
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Chief' } })
  fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: PASS } })
  fireEvent.change(screen.getByLabelText('Confirm passphrase'), { target: { value: PASS } })
  fireEvent.click(screen.getByRole('button', { name: 'Create unit' }))
  await screen.findByText('BSV TESTNET', {}, { timeout: 20_000 })
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

  it('provides desktop and mobile navigation for every section', async () => {
    render(<App controller={new DistributedAppController(new MemoryRepository())} settingsStorage={new LocalSettingsStorage(memoryStorage())} />)
    await screen.findByText('MOCK BLOCKCHAIN')
    for (const label of ['Count', 'Inventory', 'Cadets', 'Activity', 'More']) {
      expect(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: label })).toBeInTheDocument()
      expect(within(screen.getByRole('navigation', { name: 'Mobile navigation' })).getByRole('button', { name: label })).toBeInTheDocument()
    }
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Mobile navigation' })).getByRole('button', { name: 'More' }))
    expect(await screen.findByRole('heading', { name: 'Command Center', level: 1 })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Diagnostics/ }))
    expect(await screen.findByText('Data integrity healthy')).toBeInTheDocument()
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
    fireEvent.click(within(await screen.findByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Activity' }))
    expect(await screen.findByText(`Added cadet ${projection.cadets[0].cadetCode}`)).toBeInTheDocument()
    expect(screen.queryByText(/Very Private Name/)).not.toBeInTheDocument()
  })
})

describe('unit onboarding over a (fake) BSV testnet chain', { timeout: 120_000 }, () => {
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
    expect(await screen.findByText('BSV TESTNET', {}, { timeout: 20_000 })).toBeInTheDocument()
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
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'More' }))
    fireEvent.click(await screen.findByRole('button', { name: /Members & access/ }))
    fireEvent.change(screen.getByLabelText('Join code'), { target: { value: await encodeJoinRequest(joiner) } })
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'SUPPLY_OFFICER' } })
    fireEvent.click(screen.getByRole('button', { name: 'Admit' }))
    const code = (await screen.findByLabelText('Admission code', {}, { timeout: 20_000 }) as HTMLTextAreaElement).value
    expect(code).toMatch(/^ARGUS-ADMIT-1:/)
    expect(await screen.findByText('view transaction', {}, { timeout: 20_000 })).toBeInTheDocument()
    // The member list refreshes after the admission code appears, so wait for it rather than reading it synchronously.
    const people = screen.getByRole('list', { name: 'People in this unit' })
    expect(await within(people).findByText(/Jordan/, {}, { timeout: 20_000 })).toBeInTheDocument()

    // On the joiner's device: unlock, see the waiting screen with a join code, paste the admission code.
    document.body.innerHTML = ''
    render(<App runtimeOptions={runtimeOptions(chain)} storage={joinerStorage} settingsStorage={new LocalSettingsStorage(memoryStorage())} />)
    fireEvent.change(await screen.findByLabelText('Passphrase'), { target: { value: 'another pass 77' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    expect((await screen.findByLabelText('Your join code', {}, { timeout: 20_000 }) as HTMLTextAreaElement).value).toMatch(/^ARGUS-JOIN-1:/)
    fireEvent.change(screen.getByLabelText('Admission code'), { target: { value: code } })
    fireEvent.click(screen.getByRole('button', { name: 'Join unit' }))
    expect(await screen.findByText('BSV TESTNET', {}, { timeout: 20_000 })).toBeInTheDocument()
    expect(screen.getAllByText('Supply Officer').length).toBeGreaterThan(0)
    expect(loadDeviceVault(joinerStorage)?.unit?.unitId).toBe(loadDeviceVault(masterStorage)?.unit?.unitId)
  })

  it('locks back to the unlock screen and rejects a wrong passphrase', async () => {
    const chain = new FakeChain()
    await createUnitThroughUi(chain)
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'More' }))
    fireEvent.click(await screen.findByRole('button', { name: /Lock this device/ }))
    fireEvent.change(await screen.findByLabelText('Passphrase'), { target: { value: 'wrong passphrase 9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    expect(await screen.findByRole('alert', {}, { timeout: 20_000 })).toHaveTextContent('not correct')
  })
})
