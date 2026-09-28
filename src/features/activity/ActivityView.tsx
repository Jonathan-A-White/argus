import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { Activity, AlertTriangle, Boxes, CalendarRange, ClipboardCheck, ExternalLink, KeyRound, Shirt, Users } from 'lucide-react'
import type { ArgusAppProjection } from '../../distributed/appIntegration'
import { isVerified } from '../../distributed/delivery'
import type { LocalSyncStatus, SignedArgusEvent } from '../../distributed/types'
import type { UnitRuntime, UnitStatus } from '../../unit/runtime'
import { SYNC_STATUS_TEXT, auditHash, describeActivity, verificationOf, type ActivityDescription } from './activityModel'
import './activity.css'

export type ActivityViewProps = {
  projection: ArgusAppProjection
  memberName: (publicIdentity: string) => string
  runtime?: Pick<UnitRuntime, 'device'>
  status?: Pick<UnitStatus, 'queued' | 'anchorAddress'>
}

const KIND_ICON: Record<string, typeof Activity> = { Item: Boxes, 'Catalog item': Boxes, Cadet: Users, Cadets: Users, Count: ClipboardCheck, 'Supply event': CalendarRange, Member: KeyRound, 'Unit key': KeyRound, Bundle: Shirt, 'Still needed': ClipboardCheck, Conflict: AlertTriangle }
const STATUS_ORDER: LocalSyncStatus[] = ['LOCAL', 'QUEUED', 'SYNCING', 'SYNCHRONIZED', 'CONFLICT', 'FAILED']
const entryId = (eventId: string) => `activity-${eventId}`

/**
 * Activity / audit view (master spec §36): every change in plain words — what happened, to which
 * record, by whom, whether the unit has it (sync status) and whether it is recorded in a mined
 * block (verification). Hashes, transaction IDs and signers stay under "Technical details".
 */
export function ActivityView({ projection, memberName, runtime, status }: ActivityViewProps) {
  const mode = projection.sync.mode
  const entries = useMemo(() => [...projection.events]
    .sort((a, b) => a.event.timestamp < b.event.timestamp ? 1 : a.event.timestamp > b.event.timestamp ? -1 : 0)
    .map(record => ({ record, description: describeActivity(projection, record, memberName) })), [projection, memberName])
  const titles = new Map(entries.map(entry => [entry.record.event.eventId, entry.description.title]))
  const correctedBy = new Map<string, string[]>()
  for (const { record, description } of entries) if (description.correction?.originalEventId) correctedBy.set(description.correction.originalEventId, [...(correctedBy.get(description.correction.originalEventId) ?? []), record.event.eventId])
  const rejected = new Map(projection.rejected.map(entry => [entry.eventId, entry.reason]))
  const verified = projection.events.filter(isVerified).length

  return (
    <div className="content activity-view">
      <section className="page-intro">
        <div>
          <p className="eyebrow">AUDIT TRAIL</p>
          <h2>Nothing changes silently.</h2>
          <p>
            {mode === 'local'
              ? 'Every change is signed by the person who made it. This demo keeps changes on this device only, so they read LOCAL and are never verified on a blockchain.'
              : 'Every change is signed by the person who made it and checked on every device. SYNCHRONIZED means the whole unit has it; VERIFIED means it is permanently recorded in a mined block on the BSV testnet chain.'}
          </p>
        </div>
      </section>
      <section className="distributed-panel" aria-label="A.R.G.U.S. distributed system">
        <strong>{runtime ? `SHARED ON BSV TESTNET · ${runtime.device.record.unit?.unitName ?? ''}` : 'MOCK BLOCKCHAIN · THIS DEVICE ONLY'}</strong>
        <div>
          <span><small>YOU</small>{runtime?.device.record.displayName ?? 'Demo user'}</span>
          <span><small>EVENTS</small>{projection.events.length}</span>
          <span><small>VERIFIED</small>{verified}</span>
          <span><small>WAITING TO PUBLISH</small>{status?.queued ?? projection.sync.outbox}</span>
          <span><small>CONFLICTS</small>{projection.sync.openConflicts}</span>
          <span><small>LOCAL COPY</small>Encrypted</span>
          {status && (
            <span>
              <small>HISTORY</small>
              <a href={`https://test.whatsonchain.com/address/${status.anchorAddress}`} target="_blank" rel="noreferrer">On chain <ExternalLink size={12} /></a>
            </span>
          )}
        </div>
      </section>
      <details className="activity-legend">
        <summary>What do these labels mean?</summary>
        <dl>
          {STATUS_ORDER.map(value => (
            <div key={value}><dt><b className={`sync-badge sync-${value.toLowerCase()}`}>{value}</b></dt><dd>{SYNC_STATUS_TEXT[value]}.</dd></div>
          ))}
          <div><dt><span className="verify-label verified">VERIFIED</span></dt><dd>Recorded in a mined block of the BSV testnet chain, so it can no longer be changed or lost.</dd></div>
        </dl>
      </details>
      <div className="timeline" role="list" aria-label="Activity">
        {entries.length ? (
          entries.map(({ record, description }) => (
            <ActivityEntry
              key={record.event.eventId}
              record={record}
              description={description}
              actor={memberName(record.event.actorPublicIdentity)}
              mode={mode}
              notApplied={rejected.get(record.event.eventId)}
              originalTitle={description.correction ? titles.get(description.correction.originalEventId) : undefined}
              correctedBy={(correctedBy.get(record.event.eventId) ?? []).map(id => ({ eventId: id, title: titles.get(id) ?? 'a correction' }))}
            />
          ))
        ) : (
          <p className="empty-state">No changes recorded yet.</p>
        )}
      </div>
    </div>
  )
}

/** Scrolls to another entry (a correction and the entry it corrects point at each other). */
function jumpTo(eventId: string) {
  return (click: MouseEvent<HTMLAnchorElement>) => {
    click.preventDefault()
    const target = document.getElementById(entryId(eventId))
    target?.scrollIntoView?.({ block: 'center' })
    target?.focus()
  }
}

function ActivityEntry({ record, description, actor, mode, notApplied, originalTitle, correctedBy }: {
  record: ArgusAppProjection['events'][number]
  description: ActivityDescription
  actor: string
  mode: 'local' | 'remote'
  notApplied?: string
  originalTitle?: string
  correctedBy: Array<{ eventId: string; title: string }>
}) {
  const { event } = record, { correction } = description
  const verification = verificationOf(record, mode)
  const Icon = KIND_ICON[description.record.kind] ?? Activity
  const change = correction && (correction.from || correction.to) ? ` (${correction.from ?? '…'} → ${correction.to ?? '…'})` : ''
  return (
    <article className="event activity-entry" id={entryId(event.eventId)} tabIndex={-1} role="listitem" aria-label={description.title}>
      <span className="event-icon"><Icon /></span>
      <div className="activity-body">
        <strong>{description.title}</strong>
        <p className="activity-record"><small>{description.record.kind}</small>{description.record.label}</p>
        <p className="activity-status">
          <span>{actor}</span>
          <b className={`sync-badge sync-${record.syncStatus.toLowerCase()}`} title={SYNC_STATUS_TEXT[record.syncStatus]}>{record.syncStatus}</b>
          <span className={verification.verified ? 'verify-label verified' : 'verify-label'}>{verification.label}</span>
          {notApplied && <><b className="sync-badge sync-not-applied">NOT APPLIED</b><span>{notApplied}</span></>}
        </p>
        {correction?.originalEventId && (
          <p className="activity-correction">
            Corrects{' '}
            {originalTitle ? <a href={`#${entryId(correction.originalEventId)}`} onClick={jumpTo(correction.originalEventId)}>{originalTitle}</a> : 'an earlier entry'}
            {change}
          </p>
        )}
        {correctedBy.map(later => (
          <p className="activity-correction" key={later.eventId}>
            Corrected later: <a href={`#${entryId(later.eventId)}`} onClick={jumpTo(later.eventId)}>{later.title}</a>
          </p>
        ))}
        <details className="audit-metadata">
          <summary>Technical details</summary>
          <span><b>Change</b>{event.eventType} · {event.eventId}</span>
          <span><b>Signed by</b>{actor} · {event.actorPublicIdentity.slice(0, 24)}…</span>
          <span className="audit-hash-row"><b>Audit hash (SHA-256)</b><AuditHash event={event} /></span>
          <span><b>Network</b>{mode === 'local' ? 'None — demo, this device only' : 'BSV testnet'}</span>
          {record.transactionId && (
            <span>
              <b>Testnet transaction</b>
              <a href={`https://test.whatsonchain.com/tx/${record.transactionId}`} target="_blank" rel="noreferrer">{record.transactionId.slice(0, 16)}…</a>
            </span>
          )}
          {record.blockHeight ? <span><b>Block</b>{record.blockHeight}</span> : null}
          {correction?.originalEventId && <span><b>Corrects change</b>{correction.originalEventId}</span>}
          {record.lastError && <span><b>Last attempt</b>{record.lastError}</span>}
        </details>
      </div>
      <time dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleString()}</time>
    </article>
  )
}

function AuditHash({ event }: { event: SignedArgusEvent }) {
  const [hash, setHash] = useState<string>()
  useEffect(() => {
    let live = true
    void auditHash(event).then(value => { if (live) setHash(value) })
    return () => { live = false }
  }, [event])
  return <code className="audit-hash">{hash ?? 'computing…'}</code>
}
