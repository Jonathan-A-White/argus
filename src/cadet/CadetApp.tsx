import { useMemo, useState } from 'react'
import { WhatsOnChainApi } from '../chain/woc'
import type { ChainApi } from '../chain/types'
import type { CadetViewHaveLine, CadetViewNeedLine } from '../distributed/types'
import type { UnlockedCadetDevice } from '../unit/vault'
import { useCadetPoller } from './CadetPoller'
import { formatWhen } from './format'
import './cadet.css'

export type CadetAppProps = {
  device: UnlockedCadetDevice
  /** Tests inject a fake chain; the phone reads BSV testnet through WhatsOnChain. */
  api?: ChainApi
  /** Called once the cadet has confirmed leaving; the caller wipes the phone's record. */
  onLeave: () => void | Promise<void>
}

/**
 * Cadet mode (ADR 013): what a cadet's phone shows instead of the staff app. One screen, My gear, read from the cadet's own channel,
 * and a Settings sheet with Leave. There are no tabs and no unit screen: the phone holds no unit key to show one with.
 */
export function CadetApp({ device, api, onLeave }: CadetAppProps) {
  const cadet = device.cadet!
  const chain = useMemo(() => api ?? new WhatsOnChainApi(), [api])
  const poll = useCadetPoller(cadet, chain)
  const [settings, setSettings] = useState(false)
  const { view } = poll
  return (
    <div className="cadet-app">
      <div className="environment-banner testnet cadet-banner" role="note"><strong>BSV TESTNET</strong><span>Development Environment · No Production Transactions</span></div>
      <header className="cadet-header">
        <div><p className="eyebrow">Cadet</p><h1>{cadet.unit.unitName}</h1></div>
        <button className="secondary-button" onClick={() => setSettings(true)}>Settings</button>
      </header>
      <main className="cadet-main">
        <section className="cadet-card" aria-labelledby="cadet-gear-title">
          <h2 id="cadet-gear-title">My gear</h2>
          <p className="cadet-who"><strong>{view?.fullName ?? cadet.displayName}</strong>{view && <span className="cadet-code">{view.cadetCode}</span>}</p>
          {view && <p className="cadet-updated">{poll.offline ? 'Last updated' : 'Updated'} {formatWhen(view.updatedAt)}</p>}
          {poll.offline && <div className="validation" role="status">{view ? 'Could not reach the network, so this is the last record this phone read. ' : 'Could not reach the network. '}Press Refresh to try again.</div>}
          {!view && poll.loaded && !poll.offline && <div className="validation" role="status">The supply counter has not published your gear yet. Check again after your next visit.</div>}
          {!view && !poll.loaded && <p role="status">Reading your gear…</p>}
          {view && (
            <>
              <section className="cadet-list" aria-label="Have"><h3>Have</h3><Lines empty="Nothing issued yet" lines={view.have} /></section>
              <section className="cadet-list" aria-label="Still needed"><h3>Still needed</h3><Lines empty="Nothing still needed" lines={view.stillNeeded} /></section>
            </>
          )}
          <button className="primary-button cadet-refresh" onClick={poll.refresh}>{poll.checking ? 'Refreshing…' : 'Refresh'}</button>
        </section>
      </main>
      {settings && <SettingsSheet unitName={cadet.unit.unitName} name={cadet.displayName} close={() => setSettings(false)} leave={onLeave} />}
    </div>
  )
}

function Lines({ lines, empty }: { lines: Array<CadetViewHaveLine | CadetViewNeedLine>; empty: string }) {
  if (!lines.length) return <p className="cadet-empty">{empty}</p>
  return (
    <ul className="cadet-lines">
      {lines.map((line, index) => (
        <li key={index}><span className="cadet-item">{line.label}</span>{line.size && <span className="cadet-size">Size {line.size}</span>}<span className="cadet-qty">Qty {line.quantity}</span></li>
      ))}
    </ul>
  )
}

function SettingsSheet({ unitName, name, close, leave }: { unitName: string; name: string; close: () => void; leave: () => void | Promise<void> }) {
  const [asking, setAsking] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const confirm = async () => {
    setBusy(true); setError('')
    try { await leave() } catch (cause) { setError(cause instanceof Error ? cause.message : 'This phone could not leave the unit.'); setBusy(false) }
  }
  return (
    <div className="modal-backdrop cadet-backdrop">
      <div className="modal cadet-sheet" role="dialog" aria-modal="true" aria-label="Settings">
        <h2>Settings</h2>
        <p>This phone belongs to {name} in {unitName}.</p>
        {asking ? (
          <>
            <div className="workflow-warning" role="alert">Leaving erases this phone&apos;s copy of your ticket and keys. To see your gear here again you will need a new ticket from your supply counter.</div>
            {error && <div className="workflow-error" role="alert">{error}</div>}
            <div className="modal-actions">
              <button type="button" onClick={() => setAsking(false)} disabled={busy}>Keep my place</button>
              <button type="button" className="primary-button" onClick={() => void confirm()} disabled={busy}>{busy ? 'Leaving…' : 'Yes, leave this unit'}</button>
            </div>
          </>
        ) : (
          <div className="modal-actions">
            <button type="button" onClick={close}>Close</button>
            <button type="button" className="primary-button" onClick={() => setAsking(true)}>Leave this unit</button>
          </div>
        )}
      </div>
    </div>
  )
}
