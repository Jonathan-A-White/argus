import { useState } from 'react'

export function UnlockScreen({ onUnlock }: { onUnlock: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await onUnlock(password)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The application credential password is incorrect or the credential is damaged.')
      setBusy(false)
    }
  }

  return (
    <main className="loading-state" aria-live="polite">
      <form className="modal" aria-label="Unlock A.R.G.U.S." onSubmit={submit}>
        <h2>Unlock A.R.G.U.S.</h2>
        <p>Enter this device&apos;s passphrase to continue.</p>
        <label className="field">
          PASSPHRASE
          <input type="password" aria-label="Passphrase" value={password} onChange={event => setPassword(event.target.value)} required autoFocus />
        </label>
        {error && (
          <div className="workflow-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button className="primary-button" type="submit" disabled={busy}>
            Unlock
          </button>
        </div>
      </form>
    </main>
  )
}
