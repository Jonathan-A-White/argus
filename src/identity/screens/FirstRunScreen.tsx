import { useState } from 'react'
import { createJoiningDeviceIdentity, createMasterDeviceIdentity, type DeviceIdentityRecord } from '../deviceIdentity'

type Choice = 'master' | 'join'

export function FirstRunScreen({ onReady }: { onReady: (record: DeviceIdentityRecord, password: string) => Promise<void> }) {
  const [choice, setChoice] = useState<Choice>()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  if (!choice) {
    return (
      <main className="loading-state" aria-live="polite">
        <div className="modal">
          <h2>Set up this device</h2>
          <p>A.R.G.U.S. has not been set up on this device yet.</p>
          <div className="modal-actions">
            <button className="primary-button" onClick={() => setChoice('master')}>
              Create this unit&apos;s Master identity
            </button>
            <button onClick={() => setChoice('join')}>Join a unit</button>
          </div>
        </div>
      </main>
    )
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (password !== confirm) {
      setError('Passphrases do not match.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const record = choice === 'master' ? await createMasterDeviceIdentity(password) : await createJoiningDeviceIdentity(password)
      await onReady(record, password)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The device identity could not be created.')
      setBusy(false)
    }
  }

  const title = choice === 'master' ? "Create this unit's Master identity" : 'Join a unit'
  return (
    <main className="loading-state" aria-live="polite">
      <form className="modal" aria-label={title} onSubmit={submit}>
        <h2>{title}</h2>
        <p>
          Choose a passphrase for this device (at least 12 characters, including a letter and a number). It is not
          recoverable: if it is lost, a new device identity must be enrolled.
        </p>
        <label className="field">
          PASSPHRASE
          <input type="password" aria-label="Passphrase" value={password} onChange={event => setPassword(event.target.value)} minLength={12} required autoFocus />
        </label>
        <label className="field">
          CONFIRM PASSPHRASE
          <input type="password" aria-label="Confirm passphrase" value={confirm} onChange={event => setConfirm(event.target.value)} minLength={12} required />
        </label>
        {error && (
          <div className="workflow-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" onClick={() => setChoice(undefined)}>
            Back
          </button>
          <button className="primary-button" type="submit" disabled={busy}>
            {choice === 'master' ? 'Create Master identity' : 'Join this unit'}
          </button>
        </div>
      </form>
    </main>
  )
}
