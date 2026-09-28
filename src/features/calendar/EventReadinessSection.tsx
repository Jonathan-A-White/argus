import { useId, type JSX } from 'react'
import { ChevronRight, GraduationCap } from 'lucide-react'
import type { ArgusAppProjection } from '../../distributed/appIntegration'
import type { CalendarEventProjection } from '../../distributed/types'
import { amiReadiness } from '../../stage3/amiReadiness'
import { endOfYearReview } from '../../stage3/endOfYear'
import { PREPARATION_KINDS, RETURNABLE_KINDS, combinedEventReadiness, eventReadiness, postEventReturns, type EventReadiness } from '../../stage3/eventReadiness'
import type { AlertTarget, SyncSnapshot } from '../../stage3/readinessTypes'
import { AmiCategoryList, ReadinessMeter, RolloverChecklist } from '../readiness/ReadinessParts'
import { daysUntil } from './calendarModel'
import { plural } from '../../plural'

export type EventReadinessSectionProps = {
  event: CalendarEventProjection
  projection: ArgusAppProjection
  now: Date
  sync?: SyncSnapshot
  /** Opens a record or screen elsewhere in the app; without it the section is read-only text. */
  navigate?: (target: AlertTarget) => void
}


/**
 * The readiness part of an event's drawer (spec §15–19): cadet preparation and stock for bundle
 * events (NCO, BLT, Military Ball), the AMI readiness dashboard, or the End-of-Year review.
 */
export function EventReadinessSection(props: EventReadinessSectionProps): JSX.Element | null {
  const { event } = props
  if (event.kind === 'AMI') return <AmiSection {...props} />
  if (event.kind === 'END_OF_YEAR') return <EndOfYearSection {...props} />
  if (PREPARATION_KINDS.includes(event.kind) || event.bundleIds.length) return <PreparationSection {...props} />
  return null
}

function Headline({ event, projection, now, sync, label }: EventReadinessSectionProps & { label: string }) {
  const combined = combinedEventReadiness(event, projection, now, sync)
  return (
    <div className="event-readiness-headline">
      <strong>{combined.percent}%</strong>
      <span>
        <b>{label}</b>
        <small>{combined.parts.length ? combined.parts.map(part => `${part.label} ${part.percent}%`).join(' · ') : 'Nothing to assess yet'}</small>
      </span>
      <ReadinessMeter label="Event readiness" percent={combined.percent} />
    </div>
  )
}

function rosterText(report: EventReadiness, event: CalendarEventProjection) {
  if (report.rosterSource === 'ATTENDEES') return `Attendee roster: ${plural(report.incoming, 'active cadet')}${event.cadetIds.length > report.incoming ? ` (${event.cadetIds.length - report.incoming} inactive or removed not counted)` : ''}.`
  if (report.rosterSource === 'NS1_DEFAULT') return `No attendee roster yet, so every active NS1 cadet counts: ${plural(report.incoming, 'cadet')}.`
  return 'No attendees linked yet. Add the attendee roster to see who still needs gear.'
}

function PreparationSection(props: EventReadinessSectionProps) {
  const { event, projection, now, navigate } = props
  const id = useId()
  const report = eventReadiness(event, projection)
  const returns = RETURNABLE_KINDS.includes(event.kind) && daysUntil(event.startsAt, now) < 0 ? postEventReturns(event, projection, now) : undefined
  const waiting = report.cadets.filter(cadet => cadet.status !== 'PREPARED')
  const stats: Array<[string, number]> = [
    ['Incoming', report.incoming],
    ['Fully prepared', report.fullyPrepared],
    ['Partially prepared', report.partiallyPrepared],
    ['Not started', report.notStarted],
    ['Missing items', report.missingItems],
    ['Missing sizes', report.missingSizes],
    ['Cadets issued', report.completedIssues.cadets],
  ]
  return (
    <section className="calendar-section event-readiness" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`}>Event readiness</h3>
      <Headline {...props} label="ready" />
      <p className="calendar-muted">{rosterText(report, event)}</p>
      {report.incoming > 0 && (
        <dl className="event-readiness-stats">
          {stats.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {report.incoming > 0 && report.completedIssues.transactions > 0 && (
        <p className="calendar-muted">
          {plural(report.completedIssues.transactions, 'issue')} of this event’s bundles recorded for the roster.
        </p>
      )}
      {report.missingSizes > 0 && (
        <p className="calendar-muted">
          {[report.sizesUnknown && `${plural(report.sizesUnknown, 'size')} not recorded on cadet records`, report.sizesNotStocked && `${plural(report.sizesNotStocked, 'recorded size')} the unit does not stock`].filter(Boolean).join(' · ')}.
        </p>
      )}

      {report.shortages.length > 0 && (
        <div className="event-readiness-block">
          <h4>Low-stock conflicts</h4>
          <ul className="event-readiness-list shortages">
            {report.shortages.map(entry => (
              <li key={`${entry.key}|${entry.size ?? ''}`}>
                <span>
                  <strong>
                    {entry.name} · {entry.size ?? 'size unknown'}
                  </strong>
                  <small>
                    Need {entry.needed} · {entry.stocked ? `${entry.onHand} on hand` : entry.size ? 'size not stocked' : 'no sizes set up'}
                  </small>
                </span>
                <b>−{entry.shortage}</b>
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.demand.length > 0 && (
        <details className="event-readiness-block">
          <summary>Projected stock requirement ({report.demand.length})</summary>
          <ul className="event-readiness-list">
            {report.demand.map(entry => (
              <li key={`${entry.key}|${entry.size ?? ''}`}>
                <span>
                  <strong>
                    {entry.name} · {entry.size ?? 'size unknown'}
                  </strong>
                  <small>{plural(entry.cadetIds.length, 'cadet')}</small>
                </span>
                <b>
                  {entry.needed} / {entry.onHand}
                </b>
              </li>
            ))}
          </ul>
          <p className="calendar-muted">Needed / on hand. Size-unknown lines draw on what is left after known sizes.</p>
        </details>
      )}

      {waiting.length > 0 && (
        <details className="event-readiness-block">
          <summary>Cadets still missing gear ({waiting.length})</summary>
          <ul className="event-readiness-list">
            {waiting.map(cadet => (
              <li key={cadet.cadetId}>
                <CadetLine
                  label={cadet.label}
                  detail={`${cadet.satisfied}/${cadet.required} · missing ${cadet.missing.map(item => `${item.label}${item.sized ? ` (${item.size ?? 'size?'})` : ''}`).join(', ')}`}
                  open={navigate ? () => navigate({ tab: 'cadets', cadetId: cadet.cadetId }) : undefined}
                />
              </li>
            ))}
          </ul>
        </details>
      )}

      {returns && (
        <div className="event-readiness-block">
          <h4>Post-event returns</h4>
          {returns.length ? (
            <ul className="event-readiness-list">
              {returns.map(entry => (
                <li key={entry.cadetId}>
                  <CadetLine
                    label={entry.label}
                    detail={`Still holds ${entry.lines.map(line => `${line.label} · ${line.variant}${line.quantity > 1 ? ` ×${line.quantity}` : ''}`).join(', ')}`}
                    open={navigate ? () => navigate({ tab: 'cadets', cadetId: entry.cadetId }) : undefined}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="calendar-muted">Every attendee has returned this event’s gear.</p>
          )}
        </div>
      )}
    </section>
  )
}

function CadetLine({ label, detail, open }: { label: string; detail: string; open?: () => void }) {
  const body = (
    <span>
      <strong>{label}</strong>
      <small>{detail}</small>
    </span>
  )
  if (!open) return body
  return (
    <button type="button" className="event-readiness-cadet" onClick={open} aria-label={`Open cadet ${label}`}>
      {body}
      <ChevronRight aria-hidden="true" />
    </button>
  )
}

function AmiSection(props: EventReadinessSectionProps) {
  const { projection, now, sync, navigate } = props
  const id = useId()
  const report = amiReadiness(projection, sync, now)
  return (
    <section className="calendar-section event-readiness" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`}>AMI readiness</h3>
      <div className="event-readiness-headline">
        <strong>{report.overall}%</strong>
        <span>
          <b>AMI readiness</b>
          <small>Average of the six inspection categories below</small>
        </span>
        <ReadinessMeter label="AMI readiness" percent={report.overall} />
      </div>
      <AmiCategoryList categories={report.categories} navigate={navigate} />
    </section>
  )
}

function EndOfYearSection(props: EventReadinessSectionProps) {
  const { projection, now, navigate } = props
  const id = useId()
  const review = endOfYearReview(projection, now)
  return (
    <section className="calendar-section event-readiness" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`}>End-of-Year review</h3>
      <div className="event-readiness-headline">
        <strong>{review.percent}%</strong>
        <span>
          <b>{review.ready ? 'Ready for rollover' : 'Rollover readiness'}</b>
          <small>
            Count coverage {review.coverage.counted}/{review.coverage.total} sizes · {plural(review.discrepancies.length, 'discrepancy', 'discrepancies')} · {plural(review.returnPending.length, 'return-pending cadet')}
          </small>
        </span>
        <ReadinessMeter label="Rollover readiness" percent={review.percent} />
      </div>
      <RolloverChecklist checklist={review.checklist} />

      {review.discrepancies.length > 0 && (
        <details className="event-readiness-block">
          <summary>Count discrepancies ({review.discrepancies.length})</summary>
          <ul className="event-readiness-list">
            {review.discrepancies.map(entry => (
              <li key={`${entry.sessionId}|${entry.itemId}`}>
                <span>
                  <strong>
                    {entry.name} · {entry.variant}
                  </strong>
                  <small>
                    Expected {entry.expected}, counted {entry.counted}
                    {entry.movement ? ' · stock moved during the count' : ''} · {entry.scope}
                  </small>
                </span>
                <b>
                  {entry.difference > 0 ? '+' : entry.difference < 0 ? '−' : '±'}
                  {Math.abs(entry.difference)}
                </b>
              </li>
            ))}
          </ul>
        </details>
      )}

      {review.returnPending.length > 0 && (
        <details className="event-readiness-block">
          <summary>Return-pending cadets ({review.returnPending.length})</summary>
          <ul className="event-readiness-list">
            {review.returnPending.map(entry => (
              <li key={entry.cadetId}>
                <CadetLine
                  label={entry.label}
                  detail={`${entry.reason === 'INACTIVE' ? 'Inactive' : 'Graduating NS4'} · holds ${plural(entry.items, 'item')}`}
                  open={navigate ? () => navigate({ tab: 'cadets', cadetId: entry.cadetId }) : undefined}
                />
              </li>
            ))}
          </ul>
        </details>
      )}

      {navigate && (
        <button type="button" className="secondary-button calendar-inline-action event-readiness-rollover" onClick={() => navigate({ tab: 'more', panel: 'rollover' })}>
          <GraduationCap aria-hidden="true" /> Start annual rollover
        </button>
      )}
    </section>
  )
}
