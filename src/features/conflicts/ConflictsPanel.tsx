import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Drawer } from '../../components/Drawer'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { ArgusPermission, ConflictOutcome, ConflictRecord } from '../../distributed/types'
import { OUTCOME_LABELS, cadetCode, describeEvent, describeShortfall, losingIssueLines } from './conflictModel'
import './conflicts.css'

type Props = { projection: ArgusAppProjection; controller: DistributedAppController; can: (permission: ArgusPermission) => boolean; memberName: (publicIdentity: string) => string; close: () => void; onProjection: (projection: ArgusAppProjection) => void; notify: (message: string) => void }

/**
 * Master specification §23: conflicts are never hidden. Each one shows the resulting impossible
 * state, the cadet whose transaction lost, and the competing events with when and by whom they were
 * recorded. An authorized person (conflicts.resolve) chooses an explicit outcome — keep the record
 * as it is, or record the losing issue's items as Still Needed for that cadet — and a note. The
 * resolution is itself a signed event every device folds the same way; nothing is silently dropped.
 */
export function ConflictsPanel({ projection, controller, can, memberName, close, onProjection, notify }: Props) {
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [outcomes, setOutcomes] = useState<Record<string, ConflictOutcome>>({})
  const [busy, setBusy] = useState<string>()
  const open = projection.conflicts.filter(conflict => conflict.status === 'OPEN'), resolved = projection.conflicts.filter(conflict => conflict.status === 'RESOLVED')
  const canResolve = can('conflicts.resolve')

  const resolve = async (conflict: ConflictRecord, outcome: ConflictOutcome) => {
    if (busy) return
    setBusy(conflict.id)
    try {
      onProjection(await controller.resolveConflict(conflict.id, notes[conflict.id] ?? '', outcome))
      notify(outcome === 'RECORD_STILL_NEEDED' ? `Conflict resolved: the items were recorded as Still Needed for ${cadetCode(projection, conflict.cadetId) ?? 'the cadet'}.` : 'Conflict resolution recorded for every device.')
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'The resolution could not be recorded.') }
    finally { setBusy(undefined) }
  }

  return (
    <Drawer title="Conflicts" icon={<AlertTriangle />} close={close}>
      {!open.length && <div className="validation" role="status"><div><strong>No open conflicts</strong><p>Every device agrees on stock and property.</p></div></div>}
      {open.map(conflict => {
        const items = (conflict.inventoryItemIds ?? [conflict.entityId]).map(id => projection.inventory.find(item => item.entityId === id)).filter(item => item !== undefined)
        const cadet = cadetCode(projection, conflict.cadetId)
        const stillNeeded = losingIssueLines(projection, conflict)
        const outcome = outcomes[conflict.id] ?? 'KEEP_AS_IS'
        const note = notes[conflict.id] ?? ''
        const shortfalls = conflict.shortfalls ?? []
        return (
          <article className="panel-rows conflict-card" key={conflict.id} aria-label="Open conflict">
            <p className="conflict-reason"><strong>{conflict.reason}</strong></p>
            {shortfalls.length > 0 && (
              <div className="conflict-impossible" role="group" aria-label="Resulting impossible state">
                <small>RESULTING IMPOSSIBLE STATE</small>
                <ul>{shortfalls.map(shortfall => <li key={`${shortfall.kind}:${shortfall.itemId}`}>{describeShortfall(shortfall, cadet)}</li>)}</ul>
              </div>
            )}
            {cadet && <p className="conflict-cadet"><small>LOSING CADET</small><br /><b>{cadet}</b> — this cadet’s transaction was not applied.</p>}
            {items.map(item => <p key={item.entityId} className="conflict-stock"><small>AFFECTED STOCK</small><br />{item.name} · {item.variant} — {item.onHand} on hand now</p>)}
            <div className="conflict-events">
              <small>COMPETING EVENTS</small>
              <ol>
                {conflict.eventIds.map(eventId => {
                  const detail = describeEvent(projection, eventId, memberName)
                  return (
                    <li key={eventId}>
                      <span>{detail.label}<br /><small>{detail.who}{detail.when ? ` · ${detail.when}` : ''}</small></span>
                      <em className={`status-badge ${detail.applied ? 'success' : 'danger'}`}>{detail.applied ? 'Applied' : 'Not applied'}</em>
                    </li>
                  )
                })}
              </ol>
            </div>
            <p className="conflict-guidance">The first event in canonical order was applied; the one marked “Not applied” was not. Check the physical stock, then choose an outcome and note what you did.</p>
            {canResolve ? (
              <fieldset className="conflict-resolution" disabled={busy === conflict.id}>
                <legend>Outcome</legend>
                <label className="conflict-outcome">
                  <input type="radio" name={`outcome-${conflict.id}`} checked={outcome === 'KEEP_AS_IS'} onChange={() => setOutcomes(current => ({ ...current, [conflict.id]: 'KEEP_AS_IS' }))} />
                  <span><b>Keep as is</b><small>The applied record stands; the losing event stays in history, unapplied.</small></span>
                </label>
                {stillNeeded && (
                  <label className="conflict-outcome">
                    <input type="radio" name={`outcome-${conflict.id}`} checked={outcome === 'RECORD_STILL_NEEDED'} onChange={() => setOutcomes(current => ({ ...current, [conflict.id]: 'RECORD_STILL_NEEDED' }))} />
                    <span><b>Record as Still Needed for {cadet}</b><small>{stillNeeded.join(', ')} — added to the cadet’s Still Needed on every device.</small></span>
                  </label>
                )}
                <label className="field">RESOLUTION NOTE<textarea aria-label="Resolution" rows={2} value={note} onChange={event => setNotes(current => ({ ...current, [conflict.id]: event.target.value }))} placeholder="e.g. Recounted: 1 jacket on the shelf; second cadet will be issued next week" /></label>
                <div className="modal-actions"><button className="primary-button" disabled={!note.trim() || busy === conflict.id} onClick={() => void resolve(conflict, outcome)}>{busy === conflict.id ? 'Saving…' : 'Record resolution'}</button></div>
              </fieldset>
            ) : <p className="safe-note">A Supply Officer or the Master resolves conflicts.</p>}
          </article>
        )
      })}
      {resolved.length > 0 && (
        <details className="panel-rows">
          <summary>{resolved.length} resolved</summary>
          {resolved.map(conflict => {
            const detail = describeEvent(projection, conflict.resolutionEventId ?? '', memberName)
            const resolution = projection.events.find(record => record.event.eventId === conflict.resolutionEventId)?.event.payload.resolution
            return <p key={conflict.id}>{conflict.reason}<br /><b>{OUTCOME_LABELS[conflict.outcome ?? 'KEEP_AS_IS']}</b>{typeof resolution === 'string' ? ` — ${resolution}` : ''}<br /><small>{detail.who} · {detail.when}</small></p>
          })}
        </details>
      )}
    </Drawer>
  )
}
