import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Drawer } from '../../components/Drawer'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { ArgusPermission } from '../../distributed/types'
import { cadetLabel } from '../../stage3/domain'

/**
 * Master specification §23: conflicts are never hidden. Each one shows the competing events, when
 * and by whom they were recorded, and the affected stock; an authorized person records how it was
 * resolved, which is itself a signed event every device sees.
 */
export function ConflictsPanel({ projection, controller, can, memberName, close, onProjection, notify }: { projection: ArgusAppProjection; controller: DistributedAppController; can: (permission: ArgusPermission) => boolean; memberName: (publicIdentity: string) => string; close: () => void; onProjection: (projection: ArgusAppProjection) => void; notify: (message: string) => void }) {
  const [notes, setNotes] = useState<Record<string, string>>({})
  const open = projection.conflicts.filter(conflict => conflict.status === 'OPEN'), resolved = projection.conflicts.filter(conflict => conflict.status === 'RESOLVED')
  const describe = (eventId: string) => {
    const record = projection.events.find(candidate => candidate.event.eventId === eventId)
    if (!record) return { label: 'Event not yet received on this device', when: '', who: '' }
    const transaction = projection.transactions.find(candidate => candidate.eventId === eventId)
    const cadet = transaction && projection.cadets.find(candidate => candidate.cadetId === transaction.cadetId)
    const lines = Array.isArray(record.event.payload.lines) ? (record.event.payload.lines as Array<{ label?: string; variant?: string; quantity?: number }>).map(line => `${line.quantity ?? ''} × ${line.label ?? ''} ${line.variant ?? ''}`).join(', ') : ''
    return { label: `${record.event.eventType.replaceAll('_', ' ').toLowerCase()}${cadet ? ` · ${cadetLabel(cadet)}` : ''}${lines ? ` · ${lines}` : ''}${transaction ? ' · applied' : ''}`, when: new Date(record.event.timestamp).toLocaleString(), who: memberName(record.event.actorPublicIdentity) }
  }
  const resolve = async (conflictId: string) => {
    try { onProjection(await controller.resolveConflict(conflictId, notes[conflictId] ?? '')); notify('Conflict resolution recorded for every device.') }
    catch (cause) { notify(cause instanceof Error ? cause.message : 'The resolution could not be recorded.') }
  }
  return (
    <Drawer title="Conflicts" icon={<AlertTriangle />} close={close}>
      {!open.length && <div className="validation" role="status"><div><strong>No open conflicts</strong><p>Every device agrees on stock and property.</p></div></div>}
      {open.map(conflict => {
        const items = (conflict.inventoryItemIds ?? [conflict.entityId]).map(id => projection.inventory.find(item => item.entityId === id)).filter(Boolean)
        return (
          <article className="panel-rows" key={conflict.id} aria-label="Open conflict">
            <p><strong>{conflict.reason}</strong></p>
            {items.map(item => <p key={item!.entityId}><small>AFFECTED STOCK</small><br />{item!.name} · {item!.variant} — {item!.onHand} on hand now</p>)}
            <ol>
              {conflict.eventIds.map(eventId => { const detail = describe(eventId); return <li key={eventId}><p>{detail.label}<br /><small>{detail.who}{detail.when ? ` · ${detail.when}` : ''}</small></p></li> })}
            </ol>
            <p className="safe-note">The first event in canonical order was applied; the others were not. Verify the physical stock, then record what you did (for example “Recounted: 1 jacket; second cadet issued a replacement size”).</p>
            {can('conflicts.resolve') ? (
              <>
                <label className="field">RESOLUTION<textarea aria-label="Resolution" rows={2} value={notes[conflict.id] ?? ''} onChange={event => setNotes(current => ({ ...current, [conflict.id]: event.target.value }))} /></label>
                <div className="modal-actions"><button className="primary-button" disabled={!(notes[conflict.id] ?? '').trim()} onClick={() => void resolve(conflict.id)}>Record resolution</button></div>
              </>
            ) : <p className="safe-note">A Supply Officer or the Master resolves conflicts.</p>}
          </article>
        )
      })}
      {resolved.length > 0 && <details className="panel-rows"><summary>{resolved.length} resolved</summary>{resolved.map(conflict => <p key={conflict.id}>{conflict.reason}<br /><small>{describe(conflict.resolutionEventId ?? '').who} · {describe(conflict.resolutionEventId ?? '').when}</small></p>)}</details>}
    </Drawer>
  )
}
