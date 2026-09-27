import { useState } from 'react'
import { Activity, Eye, EyeOff, Lock, PackageMinus, PackagePlus, Pencil, Ruler, UserRound } from 'lucide-react'
import { Drawer, Summary } from '../../components/Drawer'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { ArgusPermission, PropertyCorrection, SupplyTransaction } from '../../distributed/types'
import { cadetLabel } from '../../stage3/domain'
import { CadetForm } from './CadetForm'
import { SizeCorrectionForm } from './SizeCorrectionForm'
import { cadetMonogram, memberLabel } from './cadetDisplay'
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
const describeCorrection = (projection: ArgusAppProjection, correction: PropertyCorrection) => {
  const from = projection.inventory.find(item => item.entityId === correction.fromItemId)
  const to = projection.inventory.find(item => item.entityId === correction.toItemId)
  return `${from?.name ?? to?.name ?? 'Issued item'}: ${from?.variant ?? 'unknown size'} → ${to?.variant ?? 'unknown size'}`
}

/**
 * One cadet's property record. The drawer is titled by cadet ID; the encrypted name is rendered only
 * after the operator taps "Show name". That reveal lives in this component's state, so it resets
 * whenever the drawer closes and is never persisted.
 */
export function CadetDrawer({ cadet, projection, controller, can, onProjection, notify, onIssue, onReturn, close }: CadetDrawerProps) {
  const [nameRevealed, setNameRevealed] = useState(false)
  const [editing, setEditing] = useState(false)
  const [correctingId, setCorrectingId] = useState<string>()
  const code = cadetLabel(cadet)
  const canReveal = can('cadets.read') || can('cadets.manage')
  const canManage = can('cadets.manage')
  const canCorrect = can('inventory.adjust')
  const canIssue = can('inventory.issue') && cadet.status === 'ACTIVE'
  const canReturn = can('inventory.return') && cadet.currentProperty.length > 0
  const needs = projection.stillNeeded.filter(need => need.cadetId === cadet.cadetId)
  const history = projection.transactions
    .filter(transaction => transaction.cadetId === cadet.cadetId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const corrections = projection.corrections
    .filter(correction => correction.cadetId === cadet.cadetId)
    .sort((a, b) => b.at.localeCompare(a.at))
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
          cadet.currentProperty.map(property => {
            const correcting = canCorrect && correctingId === property.propertyId
            return (
              <div className="cadet-property" key={property.propertyId}>
                <div className={canCorrect ? 'needed-row cadet-property-row' : 'needed-row'}>
                  <span>
                    <strong>{property.label}</strong>
                    <small>{property.variant} · Qty {property.quantity} · Issued {formatDate(property.issuedAt)}</small>
                  </span>
                  <b>{property.quantity}</b>
                  {canCorrect && !correcting && (
                    <button
                      type="button"
                      className="secondary-button cadet-correct-button"
                      aria-label={`Correct size of ${property.label} · ${property.variant}`}
                      onClick={() => setCorrectingId(property.propertyId)}
                    >
                      <Ruler aria-hidden="true" /> Correct size
                    </button>
                  )}
                </div>
                {correcting && (
                  <SizeCorrectionForm
                    cadetId={cadet.cadetId}
                    property={property}
                    projection={projection}
                    controller={controller}
                    onCancel={() => setCorrectingId(undefined)}
                    onCorrected={(next, correction) => {
                      setCorrectingId(undefined)
                      onProjection(next)
                      notify(`Size corrected for ${code}: ${correction.label} ${correction.from} → ${correction.to}.`)
                    }}
                  />
                )}
              </div>
            )
          })
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

      <h3>Size corrections</h3>
      <div className="cadet-record-rows">
        {corrections.length ? (
          corrections.map(correction => (
            <div className="needed-row cadet-history-row" key={correction.correctionId}>
              <span>
                <strong>{describeCorrection(projection, correction)}</strong>
                <small className="cadet-correction-reason">{correction.reason}</small>
                <small>{formatDate(correction.at)} · {memberLabel(projection, correction.actor)}</small>
              </span>
              <em className="status-badge warning">× {correction.quantity}</em>
            </div>
          ))
        ) : (
          <p className="empty-state">No size corrections.</p>
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
