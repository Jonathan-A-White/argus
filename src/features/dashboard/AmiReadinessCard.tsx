import { useId, type JSX } from 'react'
import { ChevronRight, ClipboardList } from 'lucide-react'
import type { CalendarEventProjection } from '../../distributed/types'
import type { AmiProminence, AmiReadiness } from '../../stage3/amiReadiness'
import type { AlertTarget } from '../../stage3/readinessTypes'
import { countdownLabel, formatDate } from '../calendar/calendarModel'
import { AmiCategoryList } from '../readiness/ReadinessParts'
import { readinessTone } from '../readiness/readinessModel'

export type AmiReadinessCardProps = {
  event: CalendarEventProjection
  days: number
  report: AmiReadiness
  prominence: Exclude<AmiProminence, 'hidden'>
  navigate: (target: AlertTarget) => void
}

/**
 * AMI readiness on the Home screen (spec §17). It appears 45 days before the inspection, moves to
 * the top of the dashboard in the last two weeks, and its gaps become critical alerts in the last
 * three days. Tapping the summary opens the AMI event; each category opens the screen that fixes it.
 */
export function AmiReadinessCard({ event, days, report, prominence, navigate }: AmiReadinessCardProps): JSX.Element {
  const id = useId()
  const gaps = report.categories.filter(category => category.percent < 100).length
  return (
    <section className={`dash-panel dash-ami prominence-${prominence}`} aria-labelledby={`${id}-heading`}>
      <header className="dash-panel-head">
        <h3 id={`${id}-heading`}>AMI readiness</h3>
        <span className={prominence === 'critical' ? 'dash-count critical' : 'dash-count'}>{countdownLabel(days)}</span>
      </header>
      <button type="button" className={`dash-ami-summary tone-${readinessTone(report.overall)}`} onClick={() => navigate({ tab: 'calendar', calendarEventId: event.calendarEventId })}>
        <ClipboardList aria-hidden="true" />
        <span>
          <strong>
            {report.overall}% · {event.title}
          </strong>
          <small>
            {formatDate(event.startsAt)} · {gaps ? `${gaps} of ${report.categories.length} categories need work` : 'Every category is complete'}
          </small>
        </span>
        <ChevronRight aria-hidden="true" />
      </button>
      <AmiCategoryList categories={report.categories} navigate={navigate} />
    </section>
  )
}
