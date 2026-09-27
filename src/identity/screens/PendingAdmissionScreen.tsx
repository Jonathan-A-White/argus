export function PendingAdmissionScreen({ publicIdentity, onLock }: { publicIdentity: string; onLock: () => void }) {
  return (
    <main className="loading-state" aria-live="polite">
      <div className="modal">
        <h2>Waiting for admission</h2>
        <p>
          This device has created its application identity and is waiting to be admitted by your unit&apos;s Master
          device. Share this device&apos;s public identity with your Master administrator.
        </p>
        <p className="safe-note">{publicIdentity}</p>
        <div className="modal-actions">
          <button onClick={onLock}>Lock this device</button>
        </div>
      </div>
    </main>
  )
}
