import { useId, useState, type FormEvent } from 'react'
import { Activity, AlertTriangle, CircleDashed, ShieldCheck, Users } from 'lucide-react'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { CountObservation, CountSessionProjection, InventoryProjection } from '../../distributed/types'
import { MAX_COUNT_QUANTITY, countsTowardTotal, errorMessage, initials, parseWhole, relativeTime, signed, useNow } from './countModel'

type Props = {
  session: CountSessionProjection
  variant: InventoryProjection
  actor: string
  canCorrect: boolean
  memberName: (publicIdentity: string) => string
  controller: DistributedAppController
  onProjection: (projection: ArgusAppProjection) => void
  notify: (message: string) => void
}

const STATUS_BADGE: Record<CountObservation['status'], { label: string; tone: string } | undefined> = {
  ACCEPTED: undefined,
  CORRECTED: { label: 'Corrected', tone: 'warning' },
  LATE: { label: 'Late', tone: 'danger' },
  SUPERSEDED: { label: 'Superseded', tone: '' },
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** Live view of everyone's contributions for one size in the open session. */
export function SharedPanel({ session, variant, actor, canCorrect, memberName, controller, onProjection, notify }: Props) {
  const now = useNow()
  const headingId = useId()
  const [correcting, setCorrecting] = useState<string>()
  const observations = session.observations
    .filter(observation => observation.itemId === variant.entityId)
    .sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))
  const counted = observations.filter(countsTowardTotal)
  const people = new Set(counted.map(observation => observation.actorPublicIdentity)).size
  const total = session.totals[variant.entityId] ?? 0
  const difference = total - variant.onHand

  return (
    <section className="review-card count-shared" aria-labelledby={headingId}>
      <div className="card-title">
        <span>
          <Users />
        </span>
        <div>
          <small>LIVE · EVERYONE IN THIS COUNT</small>
          <h3 id={headingId}>Shared count</h3>
        </div>
      </div>
      <div className="count-shared-total">
        <small>SHARED TOTAL</small>
        <output aria-label="Shared total">{total}</output>
        <span>
          {counted.length ? `${plural(counted.length, 'contribution', 'contributions')} from ${plural(people, 'person', 'people')}` : 'No contributions yet'}
        </span>
      </div>
      <div className="stat-row">
        <span>
          Official on hand<small>Changes only when an officer finalizes</small>
        </span>
        <strong>{variant.onHand}</strong>
      </div>
      {counted.length > 0 ? (
        <div className={difference === 0 ? 'difference match' : 'difference warning'}>
          <span>{difference === 0 ? <ShieldCheck /> : <Activity />}</span>
          <div>
            <small>IF FINALIZED NOW</small>
            <strong>
              On hand becomes {total} ({signed(difference)})
            </strong>
            <p>{difference === 0 ? 'Matches the official record.' : 'The officer reviews this difference before finalizing.'}</p>
          </div>
        </div>
      ) : (
        <div className="difference count-not-counted">
          <span>
            <CircleDashed />
          </span>
          <div>
            <small>NOT COUNTED YET</small>
            <strong>On hand stays {variant.onHand} unless someone adds a count</strong>
          </div>
        </div>
      )}
      <h4 className="count-subheading">Contributions</h4>
      {observations.length ? (
        <ul className="count-contributions" aria-label="Contributions">
          {observations.map(observation => {
            const name = memberName(observation.actorPublicIdentity)
            const badge = STATUS_BADGE[observation.status]
            const mine = observation.actorPublicIdentity === actor
            const changed = observation.effectiveQuantity !== observation.quantity
            return (
              <li key={observation.eventId} className={`count-contribution ${observation.status.toLowerCase()}`}>
                <span className="count-avatar" aria-hidden="true">
                  {initials(name)}
                </span>
                <div className="count-contribution-body">
                  <b>{name}</b>
                  <small>
                    {relativeTime(observation.timestamp, now)}
                    {observation.note ? ` · “${observation.note}”` : ''}
                  </small>
                </div>
                <strong className="count-contribution-quantity">
                  {changed ? (
                    <>
                      <s>{observation.quantity}</s>
                      <span className="sr-only"> corrected to </span> {observation.effectiveQuantity}
                    </>
                  ) : (
                    observation.quantity
                  )}
                </strong>
                {badge && <em className={`status-badge ${badge.tone}`}>{badge.label}</em>}
                {mine && canCorrect && countsTowardTotal(observation) && correcting !== observation.eventId && (
                  <button
                    type="button"
                    className="secondary-button count-correct"
                    aria-label={`Correct your count of ${observation.effectiveQuantity}`}
                    onClick={() => setCorrecting(observation.eventId)}
                  >
                    Correct
                  </button>
                )}
                {correcting === observation.eventId && (
                  <CorrectionForm
                    sessionId={session.sessionId}
                    observation={observation}
                    controller={controller}
                    onDone={next => {
                      setCorrecting(undefined)
                      onProjection(next)
                      notify('Correction saved. The shared total is updated for everyone.')
                    }}
                    onCancel={() => setCorrecting(undefined)}
                  />
                )}
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="count-empty-note">No one has added a count for this size yet.</p>
      )}
    </section>
  )
}

function CorrectionForm({
  sessionId,
  observation,
  controller,
  onDone,
  onCancel,
}: {
  sessionId: string
  observation: CountObservation
  controller: DistributedAppController
  onDone: (projection: ArgusAppProjection) => void
  onCancel: () => void
}) {
  const ids = useId()
  const [quantity, setQuantity] = useState(String(observation.effectiveQuantity))
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const value = parseWhole(quantity, 0, MAX_COUNT_QUANTITY)
    if (value === undefined) {
      setError(`Enter a whole number from 0 to ${MAX_COUNT_QUANTITY}.`)
      return
    }
    if (!reason.trim()) {
      setError('Say briefly why you are correcting it.')
      return
    }
    setBusy(true)
    setError('')
    try {
      onDone(await controller.correctCount(sessionId, observation.eventId, value, reason.trim()))
    } catch (failure) {
      setError(errorMessage(failure))
      setBusy(false)
    }
  }
  return (
    <form className="count-correction" aria-label="Correct your contribution" onSubmit={event => void submit(event)} noValidate>
      <div className="field count-field">
        <label htmlFor={`${ids}-quantity`}>Correct quantity</label>
        <input id={`${ids}-quantity`} type="number" inputMode="numeric" min={0} value={quantity} onChange={event => setQuantity(event.target.value)} />
      </div>
      <div className="field count-field">
        <label htmlFor={`${ids}-reason`}>Reason</label>
        <input id={`${ids}-reason`} maxLength={500} value={reason} placeholder="e.g. Counted one box twice" onChange={event => setReason(event.target.value)} />
      </div>
      {error && (
        <p className="workflow-error" role="alert">
          <AlertTriangle />
          {error}
        </p>
      )}
      <div className="split-actions">
        <button type="button" onClick={onCancel}>
          Keep as is
        </button>
        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? 'Saving…' : 'Save correction'}
        </button>
      </div>
    </form>
  )
}
