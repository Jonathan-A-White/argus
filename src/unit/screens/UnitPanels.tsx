import { useEffect, useState } from 'react'
import { KeyRound, Wallet } from 'lucide-react'
import { Drawer } from '../../components/Drawer'
import type { ArgusAppProjection } from '../../distributed/appIntegration'
import type { ArgusRole } from '../../distributed/types'
import type { WalletBalance } from '../../chain/types'
import { DEFAULT_MEMBER_TOP_UP_SATOSHIS, type UnitRuntime, type UnitStatus } from '../runtime'
import { roleLabel, syncLabel } from './labels'

const explorer = (kind: 'address' | 'tx', value: string) => `https://test.whatsonchain.com/${kind}/${value}`
const shortId = (value: string) => value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value

async function shareOrCopy(text: string, title: string) {
  try { if (navigator.share) { await navigator.share({ title, text }); return 'shared' } await navigator.clipboard.writeText(text); return 'copied' } catch { return 'cancelled' }
}

/** Who is in the unit, and (Master only) admitting and revoking people. */
export function MembersPanel({ runtime, projection, close, onProjection, notify }: { runtime: UnitRuntime; projection: ArgusAppProjection; close: () => void; onProjection: (projection: ArgusAppProjection) => void; notify: (message: string) => void }) {
  const record = runtime.device.record, isMaster = record.role === 'MASTER'
  const [joinCode, setJoinCode] = useState(''), [role, setRole] = useState<Exclude<ArgusRole, 'MASTER'>>('SUPPLY_ASSISTANT'), [name, setName] = useState(''), [expires, setExpires] = useState(''), [topUp, setTopUp] = useState(true)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState<{ code: string; name: string; topUpTxid?: string; topUpError?: string }>(), [shared, setShared] = useState('')
  const [revoking, setRevoking] = useState(''), [confirmRevoke, setConfirmRevoke] = useState('')
  const admit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setResult(undefined); setShared('')
    try {
      const admitted = await runtime.admit(joinCode, role, { ...(name.trim() ? { displayName: name.trim() } : {}), ...(expires ? { expiresAt: new Date(expires).toISOString() } : {}), ...(topUp ? { topUpSatoshis: DEFAULT_MEMBER_TOP_UP_SATOSHIS } : {}) })
      setResult({ code: admitted.admissionCode, name: admitted.displayName, ...(admitted.topUpTxid ? { topUpTxid: admitted.topUpTxid } : {}), ...(admitted.topUpError ? { topUpError: admitted.topUpError } : {}) })
      setJoinCode(''); setName(''); setExpires('')
      onProjection(await runtime.controller.project())
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'This person could not be admitted.') } finally { setBusy(false) }
  }
  const revoke = async (publicIdentity: string) => {
    try { onProjection(await runtime.revoke(publicIdentity)); notify('Access revoked. Their earlier work stays in the record.'); setRevoking(''); setConfirmRevoke('') }
    catch (cause) { notify(cause instanceof Error ? cause.message : 'Access could not be revoked.') }
  }
  const members = projection.members
  return (
    <Drawer title="Members & access" icon={<KeyRound />} close={close}>
      <div className="panel-rows">
        <p><small>UNIT</small><br /><strong>{record.unit?.unitName}</strong> · <code title={record.unit?.unitId}>{record.unit?.unitId}</code></p>
        <p><small>YOU</small><br /><strong>{record.displayName}</strong> · {roleLabel(record.role)}</p>
      </div>
      <h3>People in this unit</h3>
      <ul className="panel-rows" aria-label="People in this unit">
        {isMaster && <li><p><strong>{record.displayName}</strong> · Master (this device)</p></li>}
        {members.map(member => (
          <li key={member.publicIdentity}>
            <p>
              <strong>{member.publicIdentity === projection.actor ? `${member.displayName} (you)` : member.displayName}</strong> · {roleLabel(member.role)} · {member.status === 'ACTIVE' ? `admitted ${new Date(member.issuedAt).toLocaleDateString()}` : `revoked ${member.revokedAt ? new Date(member.revokedAt).toLocaleDateString() : ''}`}
              {member.walletAddress && <><br /><small>Wallet <a href={explorer('address', member.walletAddress)} target="_blank" rel="noreferrer">{shortId(member.walletAddress)}</a></small></>}
            </p>
            {isMaster && member.status === 'ACTIVE' && (revoking === member.publicIdentity
              ? <div className="modal-actions"><input aria-label={`Type REVOKE to remove ${member.displayName}`} placeholder="Type REVOKE" value={confirmRevoke} onChange={event => setConfirmRevoke(event.target.value)} /><button disabled={confirmRevoke !== 'REVOKE'} onClick={() => void revoke(member.publicIdentity)}>Revoke</button><button onClick={() => setRevoking('')}>Cancel</button></div>
              : <button className="secondary-button" onClick={() => { setRevoking(member.publicIdentity); setConfirmRevoke('') }}>Revoke access…</button>)}
          </li>
        ))}
        {!members.length && <li><p>No one else has been admitted yet.</p></li>}
      </ul>
      {isMaster ? (
        <form className="panel-rows" aria-label="Admit a person" onSubmit={admit}>
          <h3>Admit a person</h3>
          <p>Ask them to open A.R.G.U.S., choose <em>Join my unit</em>, and send you their join code.</p>
          <label className="field">JOIN CODE<textarea aria-label="Join code" rows={3} value={joinCode} onChange={event => setJoinCode(event.target.value)} required /></label>
          <label className="field">ROLE<select aria-label="Role" value={role} onChange={event => setRole(event.target.value as Exclude<ArgusRole, 'MASTER'>)}><option value="SUPPLY_ASSISTANT">Supply Assistant</option><option value="SUPPLY_OFFICER">Supply Officer</option><option value="INSTRUCTOR">Instructor</option></select></label>
          <label className="field">DISPLAY NAME (OPTIONAL)<input aria-label="Display name" value={name} onChange={event => setName(event.target.value)} maxLength={60} placeholder="Defaults to the name in their join code" /></label>
          <label className="field">ACCESS EXPIRES (OPTIONAL)<input type="date" aria-label="Access expires" value={expires} onChange={event => setExpires(event.target.value)} /></label>
          <label className="checkbox-field"><input type="checkbox" checked={topUp} onChange={event => setTopUp(event.target.checked)} /> Send them {DEFAULT_MEMBER_TOP_UP_SATOSHIS.toLocaleString()} testnet satoshis from this device&apos;s wallet so they can publish right away</label>
          {error && <div className="workflow-error" role="alert">{error}</div>}
          <div className="modal-actions"><button className="primary-button" type="submit" disabled={busy}>{busy ? 'Admitting…' : 'Admit'}</button></div>
          {result && (
            <div className="validation" role="status">
              <div>
                <strong>{result.name} admitted.</strong>
                <p>Send them this admission code. It is useless to anyone else.</p>
                <label className="field">ADMISSION CODE<textarea readOnly aria-label="Admission code" rows={4} value={result.code} /></label>
                <button type="button" onClick={() => void shareOrCopy(result.code, 'A.R.G.U.S. admission code').then(setShared)}>{shared === 'copied' ? 'Admission code copied ✓' : 'Share or copy admission code'}</button>
                {result.topUpTxid && <p>Wallet top-up sent · <a href={explorer('tx', result.topUpTxid)} target="_blank" rel="noreferrer">view transaction</a></p>}
                {result.topUpError && <p role="alert">Top-up not sent: {result.topUpError}</p>}
              </div>
            </div>
          )}
        </form>
      ) : <p className="safe-note">Only the unit Master can admit or remove people.</p>}
    </Drawer>
  )
}

/** This device's testnet wallet and how its sync with the chain is going. */
export function WalletPanel({ runtime, status, close, notify }: { runtime: UnitRuntime; status: UnitStatus; close: () => void; notify: (message: string) => void }) {
  const [balance, setBalance] = useState<WalletBalance>(), [error, setError] = useState(''), [copied, setCopied] = useState(false), [busy, setBusy] = useState(false)
  const [to, setTo] = useState(''), [amount, setAmount] = useState(String(DEFAULT_MEMBER_TOP_UP_SATOSHIS))
  const refresh = async () => { setBusy(true); setError(''); try { setBalance(await runtime.balance()) } catch (cause) { setError(cause instanceof Error ? cause.message : 'The testnet service could not be reached.') } finally { setBusy(false) } }
  useEffect(() => { let active = true; runtime.balance().then(value => { if (active) setBalance(value) }, cause => { if (active) setError(cause instanceof Error ? cause.message : 'The testnet service could not be reached.') }); return () => { active = false } }, [runtime])
  const send = async (event: React.FormEvent) => {
    event.preventDefault()
    const satoshis = Number(amount)
    if (!Number.isInteger(satoshis) || satoshis < 1) { notify('Enter a whole number of satoshis.'); return }
    try { const txid = await runtime.sendSatoshis(to.trim(), satoshis); notify(`Sent ${satoshis.toLocaleString()} testnet satoshis (${shortId(txid)}).`); await refresh() } catch (cause) { notify(cause instanceof Error ? cause.message : 'The transfer failed.') }
  }
  const address = runtime.device.record.walletAddress
  return (
    <Drawer title="Wallet & sync" icon={<Wallet />} close={close}>
      <div className="notice"><div><strong>BSV TESTNET ONLY</strong><p>These are test coins with no value. Never send real (mainnet) BSV to this address.</p></div></div>
      {status.needsFunding && <div className="workflow-error" role="alert">This device needs testnet coins to publish its {status.queued} queued change{status.queued === 1 ? '' : 's'}. Ask your Master for a top-up or use a BSV testnet faucet.</div>}
      <label className="field">THIS DEVICE&apos;S TESTNET ADDRESS<input readOnly aria-label="This device's testnet address" value={address} /></label>
      <div className="modal-actions">
        <button onClick={() => void navigator.clipboard.writeText(address).then(() => setCopied(true), () => undefined)}>{copied ? 'Address copied ✓' : 'Copy address'}</button>
        <a className="secondary-button" href={explorer('address', address)} target="_blank" rel="noreferrer">View on explorer</a>
        <button onClick={() => void refresh()} disabled={busy}>{busy ? 'Checking…' : 'Refresh balance'}</button>
      </div>
      {error && <div className="workflow-error" role="alert">{error}</div>}
      <div className="panel-rows" aria-label="Wallet balance">
        <p><small>SPENDABLE</small><br /><strong>{balance ? `${balance.spendable.toLocaleString()} satoshis` : '—'}</strong></p>
        <p><small>CONFIRMED · UNCONFIRMED</small><br />{balance ? `${balance.confirmed.toLocaleString()} · ${balance.unconfirmed.toLocaleString()}` : '—'}</p>
        <p><small>ABOUT</small><br />Each shared change costs about 2–5 satoshis; 20,000 satoshis covers thousands of changes.</p>
      </div>
      <h3>Sync with BSV testnet</h3>
      <div className="panel-rows" aria-label="Sync status">
        <p><small>STATUS</small><br /><strong>{syncLabel(status)}</strong>{status.lastError ? ` · ${status.lastError}` : ''}</p>
        <p><small>WAITING TO PUBLISH · AWAITING CONFIRMATION</small><br />{status.queued} · {status.awaitingConfirmation}</p>
        <p><small>LAST CHECKED</small><br />{status.lastScanAt ? new Date(status.lastScanAt).toLocaleString() : 'Not yet'}</p>
        <p><small>UNIT HISTORY ADDRESS</small><br /><a href={explorer('address', status.anchorAddress)} target="_blank" rel="noreferrer">{status.anchorAddress}</a></p>
        {status.unreadable > 0 && <p role="alert">{status.unreadable} record(s) could not be decrypted on this device yet.</p>}
      </div>
      <button className="primary-button" onClick={() => void runtime.syncNow().then(() => notify('Synchronized with BSV testnet.'), cause => notify(cause instanceof Error ? cause.message : 'Sync failed.'))}>Sync now</button>
      {runtime.device.record.role === 'MASTER' && (
        <form className="panel-rows" aria-label="Send testnet satoshis" onSubmit={send}>
          <h3>Top up a member</h3>
          <label className="field">TO ADDRESS<input aria-label="Recipient address" value={to} onChange={event => setTo(event.target.value)} required placeholder="m… or n…" /></label>
          <label className="field">SATOSHIS<input aria-label="Satoshis" inputMode="numeric" value={amount} onChange={event => setAmount(event.target.value)} required /></label>
          <div className="modal-actions"><button className="primary-button" type="submit">Send</button></div>
        </form>
      )}
    </Drawer>
  )
}
