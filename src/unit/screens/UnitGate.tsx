import { useEffect, useState } from 'react'
import { UnitRuntime, type UnitRuntimeOptions } from '../runtime'
import { acceptAdmission, createJoiningDevice, createMasterDevice, encodeJoinRequest, forgetDevice, loadDeviceVault, restoreFromRecoveryFile, unlockDevice, type DeviceVaultRecord, type UnlockedDevice } from '../vault'
import './unit-gate.css'

type Step = { kind: 'welcome' } | { kind: 'create' } | { kind: 'join' } | { kind: 'restore' } | { kind: 'unlock'; record: DeviceVaultRecord } | { kind: 'pending'; device: UnlockedDevice } | { kind: 'opening' } | { kind: 'ready'; runtime: UnitRuntime }

export type UnitGateProps = {
  children: (runtime: UnitRuntime, lock: () => void) => React.ReactNode
  /** Tests inject a fake chain and in-memory stores; the app uses WhatsOnChain testnet and IndexedDB. */
  runtimeOptions?: UnitRuntimeOptions
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}

/**
 * Everything before the main app: create a unit (first device = Master), join one (any other
 * person), unlock an existing device, and wait for admission. Each device creates its own keys
 * and wallet here; nothing secret is ever copied between devices.
 */
export function UnitGate({ children, runtimeOptions, storage = localStorage }: UnitGateProps) {
  const [step, setStep] = useState<Step>(() => { const record = loadDeviceVault(storage); return record ? { kind: 'unlock', record } : { kind: 'welcome' } })
  const [error, setError] = useState('')
  const open = async (device: UnlockedDevice) => {
    if (device.record.role === 'PENDING' || !device.record.unit) { setStep({ kind: 'pending', device }); return }
    setStep({ kind: 'opening' })
    try {
      const runtime = await UnitRuntime.open(device, { ...runtimeOptions, storage: runtimeOptions?.storage ?? storage })
      runtime.start()
      setStep({ kind: 'ready', runtime })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'A.R.G.U.S. could not open this unit.')
      setStep({ kind: 'unlock', record: device.record })
    }
  }
  useEffect(() => () => { if (step.kind === 'ready') step.runtime.stop() }, [step])
  const lock = () => { if (step.kind === 'ready') step.runtime.stop(); const record = loadDeviceVault(storage); setStep(record ? { kind: 'unlock', record } : { kind: 'welcome' }) }

  if (step.kind === 'ready') return <>{children(step.runtime, lock)}</>
  if (step.kind === 'opening') return <main className="loading-state unit-gate" aria-live="polite"><GateBanner /><div className="modal"><h2>Opening your unit…</h2><p>Decrypting this device&apos;s copy and checking BSV testnet for everyone&apos;s latest work.</p></div></main>
  if (step.kind === 'welcome') return <Welcome choose={kind => { setError(''); setStep({ kind }) }} />
  if (step.kind === 'restore') return <Restore back={() => setStep({ kind: 'welcome' })} submit={async input => open(await restoreFromRecoveryFile(input, storage))} />
  if (step.kind === 'create') return <CreateOrJoin mode="create" back={() => setStep({ kind: 'welcome' })} submit={async input => open(await createMasterDevice({ passphrase: input.passphrase, displayName: input.displayName, unitName: input.unitName }, storage))} />
  if (step.kind === 'join') return <CreateOrJoin mode="join" back={() => setStep({ kind: 'welcome' })} submit={async input => open(await createJoiningDevice({ passphrase: input.passphrase, displayName: input.displayName }, storage))} />
  if (step.kind === 'pending') return <Pending device={step.device} accept={async code => {
    const admitted = await acceptAdmission(step.device, code, storage)
    const runtime = await UnitRuntime.open(admitted, { ...runtimeOptions, storage: runtimeOptions?.storage ?? storage })
    await runtime.confirmAdmission()
    runtime.start()
    setStep({ kind: 'ready', runtime })
  }} lock={lock} />
  return <Unlock record={step.record} initialError={error} unlock={async passphrase => { setError(''); await open(await unlockDevice(step.record, passphrase)) }} reset={() => { void forgetDevice(storage).then(() => setStep({ kind: 'welcome' })) }} />
}

/** Spec §30: every screen of a testnet build says so, including the ones before sign-in. */
function GateBanner() {
  return <div className="environment-banner testnet unit-gate-banner" role="note"><strong>BSV TESTNET</strong><span>Development Environment · No Production Transactions</span></div>
}

function Welcome({ choose }: { choose: (kind: 'create' | 'join' | 'restore') => void }) {
  return (
    <main className="loading-state unit-gate" aria-live="polite">
      <GateBanner />
      <div className="modal">
        <p className="eyebrow">A.R.G.U.S. · BSV TESTNET</p>
        <h2>Set up this device</h2>
        <p>Everyone in your unit uses their own device and their own key. Supply data is shared by writing encrypted records to the BSV testnet blockchain — there is no server and no shared password.</p>
        <div className="unit-gate-choices">
          <button className="primary-button" onClick={() => choose('join')}>Join my unit<small>Your Master will admit you</small></button>
          <button className="secondary-button" onClick={() => choose('create')}>Create a new unit<small>Only the first person, who becomes the unit&apos;s Master</small></button>
          <button className="secondary-button" onClick={() => choose('restore')}>Restore Master from a recovery file<small>The Master&apos;s device was lost or its passphrase forgotten</small></button>
        </div>
      </div>
    </main>
  )
}

function CreateOrJoin({ mode, back, submit }: { mode: 'create' | 'join'; back: () => void; submit: (input: { unitName: string; displayName: string; passphrase: string }) => Promise<void> }) {
  const [unitName, setUnitName] = useState(''), [displayName, setDisplayName] = useState(''), [passphrase, setPassphrase] = useState(''), [confirm, setConfirm] = useState('')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const title = mode === 'create' ? 'Create a new unit' : 'Join my unit'
  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (passphrase !== confirm) { setError('The passphrases do not match.'); return }
    setBusy(true); setError('')
    try { await submit({ unitName, displayName, passphrase }) } catch (cause) { setError(cause instanceof Error ? cause.message : 'This device could not be set up.'); setBusy(false) }
  }
  return (
    <main className="loading-state unit-gate" aria-live="polite">
      <GateBanner />
      <form className="modal" aria-label={title} onSubmit={onSubmit}>
        <h2>{title}</h2>
        {mode === 'create'
          ? <p>This device becomes the unit&apos;s <strong>Master</strong>: it holds the unit authority key that admits people and the key that encrypts the unit&apos;s records. Keep this device and its passphrase safe.</p>
          : <p>This device creates its own key and wallet, then shows a <strong>join code</strong> for your Master. The Master answers with an admission code — no secrets are ever shared.</p>}
        {mode === 'create' && <label className="field">UNIT NAME<input aria-label="Unit name" value={unitName} onChange={event => setUnitName(event.target.value)} maxLength={80} required placeholder="e.g. Bethel NJROTC" /></label>}
        <label className="field">YOUR NAME OR CALL SIGN<input aria-label="Your name" value={displayName} onChange={event => setDisplayName(event.target.value)} maxLength={60} required autoComplete="nickname" /><small>Shown to the rest of the unit (stored encrypted).</small></label>
        <label className="field">PASSPHRASE<input type="password" aria-label="Passphrase" value={passphrase} onChange={event => setPassphrase(event.target.value)} minLength={12} required autoComplete="new-password" /><small>At least 12 characters with a letter and a number. It cannot be recovered.</small></label>
        <label className="field">CONFIRM PASSPHRASE<input type="password" aria-label="Confirm passphrase" value={confirm} onChange={event => setConfirm(event.target.value)} minLength={12} required autoComplete="new-password" /></label>
        {error && <div className="workflow-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={back} disabled={busy}>Back</button>
          <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Creating keys…' : mode === 'create' ? 'Create unit' : 'Create my key'}</button>
        </div>
      </form>
    </main>
  )
}

function Unlock({ record, unlock, reset, initialError }: { record: DeviceVaultRecord; unlock: (passphrase: string) => Promise<void>; reset: () => void; initialError: string }) {
  const [passphrase, setPassphrase] = useState(''), [error, setError] = useState(initialError), [busy, setBusy] = useState(false), [resetting, setResetting] = useState(false), [confirmReset, setConfirmReset] = useState('')
  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try { await unlock(passphrase) } catch (cause) { setError(cause instanceof Error ? cause.message : 'This device could not be unlocked.'); setBusy(false) }
  }
  return (
    <main className="loading-state unit-gate" aria-live="polite">
      <GateBanner />
      <form className="modal" aria-label="Unlock A.R.G.U.S." onSubmit={onSubmit}>
        <p className="eyebrow">{record.unit ? record.unit.unitName.toUpperCase() : 'WAITING FOR ADMISSION'}</p>
        <h2>Unlock A.R.G.U.S.</h2>
        <p>Welcome back, {record.displayName}. Enter this device&apos;s passphrase.</p>
        <label className="field">PASSPHRASE<input type="password" aria-label="Passphrase" value={passphrase} onChange={event => setPassphrase(event.target.value)} required autoFocus autoComplete="current-password" /></label>
        {error && <div className="workflow-error" role="alert">{error}</div>}
        <div className="modal-actions"><button className="primary-button" type="submit" disabled={busy}>{busy ? 'Unlocking…' : 'Unlock'}</button></div>
        <details className="unit-gate-reset" open={resetting} onToggle={event => setResetting((event.target as HTMLDetailsElement).open)}>
          <summary>Forgot the passphrase?</summary>
          <p>The passphrase cannot be recovered. You can erase this device and join the unit again; the Master re-admits you and everything shared returns from the chain. Anything this device had not yet published is lost.</p>
          <label className="field">TYPE ERASE TO CONFIRM<input aria-label="Type ERASE to confirm" value={confirmReset} onChange={event => setConfirmReset(event.target.value)} /></label>
          <button type="button" disabled={confirmReset !== 'ERASE'} onClick={reset}>Erase this device</button>
        </details>
      </form>
    </main>
  )
}

function Pending({ device, accept, lock }: { device: UnlockedDevice; accept: (admissionCode: string) => Promise<void>; lock: () => void }) {
  const [joinCode, setJoinCode] = useState(''), [admissionCode, setAdmissionCode] = useState(''), [copied, setCopied] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => { let active = true; void encodeJoinRequest(device).then(code => { if (active) setJoinCode(code) }); return () => { active = false } }, [device])
  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ title: 'A.R.G.U.S. join code', text: joinCode })
      else { await navigator.clipboard.writeText(joinCode); setCopied(true) }
    } catch { /* the person cancelled the share sheet */ }
  }
  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try { await accept(admissionCode) } catch (cause) { setError(cause instanceof Error ? cause.message : 'This admission code could not be accepted.'); setBusy(false) }
  }
  return (
    <main className="loading-state unit-gate" aria-live="polite">
      <GateBanner />
      <form className="modal" aria-label="Waiting for admission" onSubmit={onSubmit}>
        <h2>Waiting for admission</h2>
        <p><strong>1.</strong> Send this join code to your unit&apos;s Master (text, email or AirDrop are all fine — it contains no secret).</p>
        <label className="field">YOUR JOIN CODE<textarea readOnly aria-label="Your join code" value={joinCode} rows={4} placeholder="Preparing your join code…" /></label>
        <div className="modal-actions"><button type="button" onClick={() => void share()} disabled={!joinCode}>{copied ? 'Join code copied ✓' : 'Share or copy join code'}</button></div>
        <p><strong>2.</strong> Paste the admission code the Master sends back.</p>
        <label className="field">ADMISSION CODE<textarea aria-label="Admission code" value={admissionCode} onChange={event => setAdmissionCode(event.target.value)} rows={4} required /></label>
        {error && <div className="workflow-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={lock}>Lock</button>
          <button className="primary-button" type="submit" disabled={busy || !admissionCode.trim()}>{busy ? 'Joining…' : 'Join unit'}</button>
        </div>
        <p className="safe-note">This device&apos;s testnet wallet: <code>{device.record.walletAddress}</code></p>
      </form>
    </main>
  )
}

function Restore({ back, submit }: { back: () => void; submit: (input: { fileText: string; recoveryPassphrase: string; passphrase: string; displayName: string }) => Promise<void> }) {
  const [fileText, setFileText] = useState(''), [recoveryPassphrase, setRecoveryPassphrase] = useState(''), [displayName, setDisplayName] = useState(''), [passphrase, setPassphrase] = useState(''), [confirm, setConfirm] = useState('')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const readFile = async (file: File | undefined) => { if (file) setFileText((await file.text()).trim()) }
  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (passphrase !== confirm) { setError('The new passphrases do not match.'); return }
    setBusy(true); setError('')
    try { await submit({ fileText, recoveryPassphrase, passphrase, displayName }) } catch (cause) { setError(cause instanceof Error ? cause.message : 'The unit could not be restored.'); setBusy(false) }
  }
  return (
    <main className="loading-state unit-gate" aria-live="polite">
      <GateBanner />
      <form className="modal" aria-label="Restore Master from a recovery file" onSubmit={onSubmit}>
        <h2>Restore Master from a recovery file</h2>
        <p>This device gets its own new keys and takes the Master role back. Afterwards, open <strong>Members &amp; access</strong> and remove the lost device.</p>
        <label className="field">RECOVERY FILE<input type="file" accept=".txt,text/plain" aria-label="Recovery file" onChange={event => void readFile(event.target.files?.[0])} /><textarea aria-label="Recovery file text" rows={3} value={fileText} onChange={event => setFileText(event.target.value)} placeholder="…or paste the file's contents (starts with ARGUS-RECOVERY-1:)" required /></label>
        <label className="field">RECOVERY PASSPHRASE<input type="password" aria-label="Recovery passphrase" value={recoveryPassphrase} onChange={event => setRecoveryPassphrase(event.target.value)} required autoComplete="off" /></label>
        <label className="field">YOUR NAME OR CALL SIGN<input aria-label="Your name" value={displayName} onChange={event => setDisplayName(event.target.value)} maxLength={60} required autoComplete="nickname" /></label>
        <label className="field">NEW PASSPHRASE FOR THIS DEVICE<input type="password" aria-label="Passphrase" value={passphrase} onChange={event => setPassphrase(event.target.value)} minLength={12} required autoComplete="new-password" /><small>At least 12 characters with a letter and a number. It cannot be recovered.</small></label>
        <label className="field">CONFIRM PASSPHRASE<input type="password" aria-label="Confirm passphrase" value={confirm} onChange={event => setConfirm(event.target.value)} minLength={12} required autoComplete="new-password" /></label>
        {error && <div className="workflow-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={back} disabled={busy}>Back</button>
          <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Restoring…' : 'Restore Master'}</button>
        </div>
      </form>
    </main>
  )
}
