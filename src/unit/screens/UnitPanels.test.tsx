import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ArgusAppProjection } from '../../distributed/appIntegration'
import type { MemberProjection } from '../../distributed/types'
import type { UnitRuntime, UnitStatus } from '../runtime'
import { MembersPanel, WalletPanel } from './UnitPanels'

const CORS = 'Could not reach WhatsOnChain after 3 tries (offline, timed out, or rate-limited; its 429 reply carries no CORS header).'
const record = { role: 'SUPPLY_OFFICER', displayName: 'Jordan', signingIdentity: 'me', walletAddress: 'mjordanWalletAddress', unit: { unitId: 'u-7c03bc458c7f', unitName: 'Bethel NJROTC' } }
const baseStatus: UnitStatus = { state: 'error', anchorAddress: 'manchor', queued: 2, awaitingConfirmation: 0, lastError: CORS, unitId: record.unit.unitId, unitName: record.unit.unitName, role: 'SUPPLY_OFFICER', displayName: 'Jordan', walletAddress: record.walletAddress, unreadable: 0, revoked: false, holdsAuthority: false, currentEpoch: 'e1' }
const fakeRuntime = (status: Partial<UnitStatus> = {}, extra: Record<string, unknown> = {}) => ({ device: { record }, status: () => ({ ...baseStatus, ...status }), ...extra }) as unknown as UnitRuntime
const member = (publicIdentity: string, displayName: string): MemberProjection => ({ publicIdentity, displayName, role: 'MASTER', credentialId: `c-${publicIdentity}`, issuedAt: '2026-09-01T00:00:00.000Z', admittedBy: 'authority', admittedEventId: `e-${publicIdentity}`, status: 'ACTIVE' })
const projection = (members: MemberProjection[]) => ({ members }) as unknown as ArgusAppProjection

describe('Members & access', () => {
  it('shows the admission code without waiting for an optional wallet top-up', async () => {
    let rejectTopUp!: (reason: Error) => void
    const topUp = new Promise<string>((_, reject) => { rejectTopUp = reject })
    const admitted = { admissionCode: 'ARGUS-ADMIT-1:ready-now', displayName: 'Taylor', walletAddress: 'mTaylorWallet' }
    const nextProjection = projection([{ ...member('invitee', 'Taylor'), status: 'INVITED' }])
    const runtime = fakeRuntime({ holdsAuthority: true }, {
      device: { record: { ...record, role: 'MASTER' } },
      admit: vi.fn(async () => admitted),
      sendSatoshis: vi.fn(() => topUp),
      controller: { project: vi.fn(async () => nextProjection) },
    })
    render(<MembersPanel runtime={runtime} projection={projection([])} close={() => undefined} onProjection={() => undefined} notify={() => undefined} />)

    fireEvent.change(screen.getByLabelText('Join code'), { target: { value: 'ARGUS-JOIN-1:joiner' } })
    fireEvent.click(screen.getByRole('button', { name: 'Admit' }))

    expect((await screen.findByLabelText('Admission code') as HTMLTextAreaElement).value).toBe(admitted.admissionCode)
    expect(screen.getByText('Invitation ready. Sending the optional wallet top-up…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Admit' })).toBeEnabled()
    expect(runtime.admit).toHaveBeenCalledWith('ARGUS-JOIN-1:joiner', 'SUPPLY_ASSISTANT', {})
    expect(runtime.sendSatoshis).toHaveBeenCalledWith(admitted.walletAddress, 2_000)

    rejectTopUp(new Error('Testnet service is unavailable.'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Top-up not sent: Testnet service is unavailable.')
    expect((screen.getByLabelText('Admission code') as HTMLTextAreaElement).value).toBe(admitted.admissionCode)
  })

  it('reports a completed optional top-up without changing the admission code', async () => {
    let resolveTopUp!: (txid: string) => void
    const topUp = new Promise<string>(resolve => { resolveTopUp = resolve })
    const admitted = { admissionCode: 'ARGUS-ADMIT-1:funded', displayName: 'Taylor', walletAddress: 'mTaylorWallet' }
    const runtime = fakeRuntime({ holdsAuthority: true }, {
      device: { record: { ...record, role: 'MASTER' } },
      admit: vi.fn(async () => admitted),
      sendSatoshis: vi.fn(() => topUp),
      controller: { project: vi.fn(async () => projection([])) },
    })
    render(<MembersPanel runtime={runtime} projection={projection([])} close={() => undefined} onProjection={() => undefined} notify={() => undefined} />)
    fireEvent.change(screen.getByLabelText('Join code'), { target: { value: 'ARGUS-JOIN-1:joiner' } })
    fireEvent.click(screen.getByRole('button', { name: 'Admit' }))
    await screen.findByLabelText('Admission code')

    resolveTopUp('funding-txid')
    expect(await screen.findByRole('link', { name: 'view transaction' })).toHaveAttribute('href', expect.stringContaining('funding-txid'))
    expect(screen.queryByText(/Sending the optional wallet top-up/)).toBeNull()
    expect((screen.getByLabelText('Admission code') as HTMLTextAreaElement).value).toBe(admitted.admissionCode)
  })

  it('does not contact the wallet when the optional top-up is unchecked', async () => {
    const admitted = { admissionCode: 'ARGUS-ADMIT-1:no-funding', displayName: 'Taylor', walletAddress: 'mTaylorWallet' }
    const runtime = fakeRuntime({ holdsAuthority: true }, {
      device: { record: { ...record, role: 'MASTER' } },
      admit: vi.fn(async () => admitted),
      sendSatoshis: vi.fn(),
      controller: { project: vi.fn(async () => projection([])) },
    })
    render(<MembersPanel runtime={runtime} projection={projection([])} close={() => undefined} onProjection={() => undefined} notify={() => undefined} />)
    fireEvent.change(screen.getByLabelText('Join code'), { target: { value: 'ARGUS-JOIN-1:joiner' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /Send them testnet satoshis/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Admit' }))

    expect((await screen.findByLabelText('Admission code') as HTMLTextAreaElement).value).toBe(admitted.admissionCode)
    expect(runtime.sendSatoshis).not.toHaveBeenCalled()
    expect(screen.queryByText(/wallet top-up/)).toBeNull()
  })

  it('before the first sync explains that the member list is coming, instead of "no one else"', () => {
    const view = render(<MembersPanel runtime={fakeRuntime({ lastScanAt: undefined })} projection={projection([])} close={() => undefined} onProjection={() => undefined} notify={() => undefined} />)
    expect(screen.getByText('The member list appears after this device’s first sync with BSV testnet.')).toBeInTheDocument()
    expect(screen.queryByText('No one else has been admitted yet.')).toBeNull()
    // The raw unit ID is a technical detail, not part of the unit's name line.
    expect(screen.getByText('Bethel NJROTC').closest('p')).not.toHaveTextContent(record.unit.unitId)
    expect(screen.getByText(record.unit.unitId).closest('details')).toHaveTextContent('Technical details')
    view.unmount()

    render(<MembersPanel runtime={fakeRuntime({ lastScanAt: '2026-09-28T01:00:00.000Z' })} projection={projection([member('me', 'Jordan')])} close={() => undefined} onProjection={() => undefined} notify={() => undefined} />)
    expect(screen.getByText('No one else has been admitted yet.')).toBeInTheDocument()
  })

  it('lists the Master once the device has synced', () => {
    render(<MembersPanel runtime={fakeRuntime({ lastScanAt: '2026-09-28T01:00:00.000Z' })} projection={projection([member('me', 'Jordan'), member('boss', 'Chief')])} close={() => undefined} onProjection={() => undefined} notify={() => undefined} />)
    const people = screen.getByRole('list', { name: 'People in this unit' })
    expect(within(people).getByText('Chief')).toBeInTheDocument()
    expect(screen.queryByText(/No one else|first sync/)).toBeNull()
  })

  it('shows an invitation as waiting rather than fully admitted', () => {
    render(<MembersPanel runtime={fakeRuntime({ lastScanAt: '2026-09-28T01:00:00.000Z' }, { device: { record: { ...record, role: 'MASTER' } } })} projection={projection([{ ...member('invitee', 'Taylor'), status: 'INVITED' }])} close={() => undefined} onProjection={() => undefined} notify={() => undefined} />)
    expect(screen.getByText((_, element) => element?.tagName === 'P' && element.textContent?.includes('Invitation sent — waiting for their device') === true)).toBeInTheDocument()
    expect(screen.queryByText(/Taylor.*since/)).toBeNull()
  })
})

describe('Wallet & sync', () => {
  it('shows chain errors in plain words (technical text under Technical details) and Sync now reports the failure', async () => {
    const notify = vi.fn()
    const runtime = fakeRuntime({}, { balance: vi.fn(async () => { throw new Error(CORS) }), syncNow: vi.fn(async () => ({})) })
    render(<WalletPanel runtime={runtime} status={{ ...baseStatus }} close={() => undefined} notify={notify} />)
    const sync = screen.getByLabelText('Sync status')
    expect(within(sync).getByText('SYNC ISSUE · 2 QUEUED')).toBeInTheDocument()
    expect(sync).toHaveTextContent('The BSV testnet service could not be reached (no connection, or it is busy).')
    expect(within(sync).getByText(CORS).closest('details')).toHaveTextContent('Technical details')
    expect(within(sync).getByText('2 · 0')).toBeInTheDocument()
    expect(await screen.findByText('The BSV testnet service could not be reached (no connection, or it is busy).', { selector: '.wallet-error, .workflow-error' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
    expect(notify.mock.calls[0][0]).toBe('Could not sync with BSV testnet. The BSV testnet service could not be reached (no connection, or it is busy). 2 changes are saved on this device and will publish automatically.')
    expect(notify.mock.calls[0][0]).not.toMatch(/^Synchronized/)
  })
})
