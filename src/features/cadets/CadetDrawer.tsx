import { useState } from 'react'
import { Activity, Eye, EyeOff, Lock, PackageMinus, PackagePlus, Pencil, UserRound } from 'lucide-react'
import { Drawer, Summary } from '../../components/Drawer'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { ArgusPermission, SupplyTransaction } from '../../distributed/types'
import { cadetLabel } from '../../stage3/domain'
import { CadetForm } from './CadetForm'
import { cadetMonogram } from './cadetDisplay'
import './cadets.css'

type Cadet = ArgusAppProjection['cadets'][number]

export type CadetDrawerProps = {
  cadet: Cadet
  projection: ArgusAppProjection
  controller: DistributedAppController
  can: (permission: ArgusPermission) => boolean
  onProjection: (projection: ArgusAppProjection) => void
  notify: (message: string) => void
  onIssue: (cadetId: string) => void
  onReturn: (cadetId: string) => void
  close: () => void
}

const formatDate = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleDateString()
}
const humanStatus = (value: string) => value.replaceAll('_', ' ').toLowerCase()
const describeLines = (transaction: SupplyTransaction) => {
  const moved = transaction.lines.map(line => `${line.label} · ${line.variant} × ${line.quantity}`)
  const missing = transaction.missingLines?.length ?? 0
  if (!moved.length) return missing ? `Nothing issued · ${missing} added to Still Needed` : 'No items'
  return missing ? `${moved.join(', ')} · ${missing} added to Still Needed` : moved.join(', ')
}

/**
 * One cadet's property record. The drawer is titled by cadet ID; the encrypted name is rendered only
 * after the operator taps "Show name". That reveal lives in this component's state, so it resets
 * whenever the drawer closes and is never persisted.
 */
export function CadetDrawer({ cadet, projection, controller, can, onProjection, notify, onIssue, onReturn, close }: CadetDrawerProps) {
  const [nameRevealed, setNameRevealed] = useState(false)
  const [editing, setEditing] = useState(false)
  const code = cadetLabel(cadet)
  const canReveal = can('cadets.read') || can('cadets.manage')
  const canManage = can('cadets.manage')
  const canIssue = can('inventory.issue') && cadet.status === 'ACTIVE'
  const canReturn = can('inventory.return') && cadet.currentProperty.length > 0
  const needs = projection.stillNeeded.filter(need => need.cadetId === cadet.cadetId)
  const history = projection.transactions
    .filter(transaction => transaction.cadetId === cadet.cadetId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const ready = cadet.readiness.status === 'READY'

  if (editing && canManage) {
    return (
      <Drawer title={`Edit ${code}`} icon={<Pencil />} close={close}>
        <CadetForm
          projection={projection}
          controller={controller}
          cadet={cadet}
          nameRevealed={nameRevealed}
          onRevealName={canReveal ? () => setNameRevealed(true) : undefined}
          onCancel={() => setEditing(false)}
          onSaved={next => {
            onProjection(next)
            notify(`Cadet ${code} updated.`)
            setEditing(false)
          }}
        />
      </Drawer>
    )
  }

  return (
    <Drawer title={code} icon={<UserRound />} close={close}>
      <div className="record-hero">
        <span className="large-avatar" aria-hidden="true">{cadetMonogram(cadet)}</span>
        <div>
          <small>Cadet ID</small>
          <b>{code}</b>
          <p>{cadet.nsLevel} · {cadet.gender} · {cadet.status}</p>
        </div>
        {canManage && (
          <button className="secondary-button cadet-edit-button" onClick={() => setEditing(true)}>
            <Pencil aria-hidden="true" /> Edit
          </button>
        )}
      </div>

      <section className="cadet-name-panel" aria-label="Encrypted name">
        <span>
          <small>Name · encrypted</small>
          {nameRevealed ? (
            <strong className={cadet.fullName ? undefined : 'cadet-name-missing'}>{cadet.fullName || 'No name recorded'}</strong>
          ) : (
            <strong className="cadet-name-missing"><Lock aria-hidden="true" /> Hidden</strong>
          )}
        </span>
        {canReveal && (
          <button type="button" className="secondary-button" onClick={() => setNameRevealed(value => !value)}>
            {nameRevealed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            {nameRevealed ? 'Hide name' : 'Show name'}
          </button>
        )}
      </section>

      {cadet.profileNeedsReview && (
        <div className="notice" role="alert">
          <Activity aria-hidden="true" />
          <span>
            <strong>Profile review required</strong>
            <br />
            Migrated profile information could not be fully verified.
          </span>
        </div>
      )}

      <div className="record-stats">
        <Summary label="Property" value={String(cadet.propertyCount)} detail="Items currently held" />
        <Summary
          label="Readiness"
          value={`${cadet.readiness.percent}%`}
          detail={ready ? 'Ready' : `Incomplete · ${cadet.stillNeededCount} still needed`}
          accent={!ready}
        />
      </div>

      <h3>Current property</h3>
      <div className="cadet-record-rows">
        {cadet.currentProperty.length ? (
          cadet.currentProperty.map(property => (
            <div className="needed-row" key={property.propertyId}>
              <span>
                <strong>{property.label}</strong>
                <small>{property.variant} · Qty {property.quantity} · Issued {formatDate(property.issuedAt)}</small>
              </span>
              <b>{property.quantity}</b>
            </div>
          ))
        ) : (
          <p className="empty-state">No current property.</p>
        )}
      </div>

      <h3>Still Needed</h3>
      <div className="cadet-record-rows">
        {needs.length ? (
          needs.map(need => (
            <div className="needed-row" key={need.requirementId}>
              <span>
                <strong>{need.displayLabel}</strong>
                <small>{need.size ?? 'Size not set'} · {humanStatus(need.status)}</small>
              </span>
              <b>{need.quantityNeeded - need.quantityFulfilled}</b>
            </div>
          ))
        ) : (
          <p className="empty-state">No open requirements.</p>
        )}
      </div>

      <h3>Issue &amp; return history</h3>
      <div className="cadet-record-rows">
        {history.length ? (
          history.map(transaction => (
            <div className="needed-row cadet-history-row" key={transaction.transactionId}>
              <span>
                <strong>{formatDate(transaction.createdAt)}</strong>
                <small>{describeLines(transaction)}</small>
              </span>
              <em className={`status-badge ${transaction.transactionType === 'ISSUE' ? 'success' : 'warning'}`}>{transaction.transactionType}</em>
            </div>
          ))
        ) : (
          <p className="empty-state">No issues or returns yet.</p>
        )}
      </div>

      <div className="split-actions cadet-split-actions">
        <button disabled={!canReturn} onClick={() => onReturn(cadet.cadetId)}>
          <PackageMinus aria-hidden="true" /> Return Items
        </button>
        <button className="primary-button" disabled={!canIssue} onClick={() => onIssue(cadet.cadetId)}>
          <PackagePlus aria-hidden="true" /> Issue Items
        </button>
      </div>
      {cadet.status !== 'ACTIVE' && <p className="cadet-action-note">Inactive cadets can return property but cannot be issued new items.</p>}
    </Drawer>
  )
}
