import { useEffect, useId, useState, type CSSProperties, type JSX } from 'react'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  BellOff,
  Boxes,
  CalendarPlus,
  CalendarRange,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  ClipboardCheck,
  Gauge,
  History,
  Info,
  LayoutGrid,
  OctagonAlert,
  ShieldCheck,
  TriangleAlert,
  Users,
  Wifi,
} from 'lucide-react'
import { Drawer } from '../../components/Drawer'
import type { ArgusAppProjection } from '../../distributed/appIntegration'
import { amiProminence, amiReadiness, nextAmiEvent } from '../../stage3/amiReadiness'
import { combinedEventReadiness } from '../../stage3/eventReadiness'
import {
  alerts as supplyAlerts,
  auditSummary,
  cadetsMissingStandardIssue,
  readiness as supplyReadiness,
  stockNeedsAttention,
  upcomingEvents,
  type AlertSeverity,
  type AlertTarget,
  type ReadinessBreakdown,
  type ReadinessWeights,
  type SupplyAlert,
  type SyncSnapshot,
} from '../../stage3/readiness'
import { readinessTone } from '../readiness/readinessModel'
import {
  acknowledge,
  browserAckStorage,
  isAcknowledged,
  loadAcknowledgements,
  pruneAcknowledgements,
  saveAcknowledgements,
  unacknowledge,
  type AckStorage,
  type Acknowledgements,
} from './alertAcknowledgements'
import { AmiReadinessCard } from './AmiReadinessCard'
import {
  KIND_LABEL,
  countdownLabel,
  dateBlock,
  daysUntil,
  eventProgress,
  formatDate,
  formatTime,
  nextSupplyEvent,
  overdueTasks,
  systemClock,
  useClock,
} from '../calendar/calendarModel'
import './dashboard.css'

/** Where a node, alert or tile leads; the optional fields open the exact record (see AlertTarget). */
export type DashboardTarget = AlertTarget

export type DashboardProps = {
  projection: ArgusAppProjection
  /** `label` is the ready-made sync text, e.g. "SYNCHRONIZED"; the rest is this device's sync state. */
  sync: { label: string } & SyncSnapshot
  unitName: string
  navigate: (target: DashboardTarget) => void
  onQuickAction: (action: 'issue' | 'return' | 'count') => void
  /** Injectable clock for tests; defaults to the system clock. */
  now?: () => Date
  /** False for people without audit.read (Supply Assistants): the Activity screen is not offered. */
  canViewActivity?: boolean
  /** This device's readiness weights (Settings); defaults to equal weights. */
  weights?: ReadinessWeights
  /** Where alert acknowledgements are kept on this device; defaults to localStorage. */
  acknowledgementStorage?: AckStorage
}

type Tone = 'ok' | 'attention' | 'critical'
type NodeId = 'cadets' | 'stock' | 'events' | 'readiness'
type TreeNode = {
  id: NodeId
  label: string
  value: string
  caption: string
  ariaLabel: string
  tone: Tone
  activate: () => void
}

const CLOCK_INTERVAL_MS = 30_000
const MAX_ALERTS = 5

/* The tree is drawn in a fixed 360 × 330 coordinate space. The SVG scales uniformly and the node
   buttons are positioned with the same coordinates as percentages, so they stay on their branches
   at every width. */
const TREE_WIDTH = 360
const TREE_HEIGHT = 330
const NODE_LAYOUT: Record<NodeId, { x: number; y: number; side: 'left' | 'right'; branch: string; delay: number }> = {
  cadets: { x: 84, y: 80, side: 'left', branch: 'M180 152 C160 140 126 98 84 80', delay: 0.55 },
  stock: { x: 276, y: 80, side: 'right', branch: 'M180 152 C200 140 234 98 276 80', delay: 0.7 },
  events: { x: 84, y: 200, side: 'left', branch: 'M180 262 C158 250 122 216 84 200', delay: 0.25 },
  readiness: { x: 276, y: 200, side: 'right', branch: 'M180 262 C202 250 238 216 276 200', delay: 0.4 },
}
const TRUNK_PATH = 'M180 322 C182 292 176 266 180 236 C184 204 176 172 180 142 C183 112 178 80 180 46'
const ROOT_PATHS = [
  'M180 316 C166 321 146 325 116 328',
  'M180 316 C194 321 214 325 244 328',
  'M180 316 C175 322 167 326 152 330',
  'M180 316 C185 322 193 326 208 330',
]
const TWIG_PATHS = ['M140 120 C134 110 132 102 134 94', 'M220 120 C226 110 228 102 226 94', 'M136 232 C128 226 124 220 124 212', 'M224 232 C232 226 236 220 236 212']
const SPARKS = [
  { x: 134, y: 92, delay: 0 },
  { x: 226, y: 92, delay: 1.1 },
  { x: 124, y: 210, delay: 0.6 },
  { x: 236, y: 210, delay: 1.7 },
  { x: 166, y: 30, delay: 0.9 },
  { x: 196, y: 56, delay: 2.2 },
]

const place = (x: number, y: number): CSSProperties => ({
  left: `${(x / TREE_WIDTH) * 100}%`,
  top: `${(y / TREE_HEIGHT) * 100}%`,
})
const delayStyle = (seconds: number) => ({ '--delay': `${seconds}s` }) as CSSProperties

const SEVERITY: Record<AlertSeverity, { label: string; icon: typeof Info }> = {
  critical: { label: 'Critical', icon: OctagonAlert },
  warning: { label: 'Warning', icon: TriangleAlert },
  info: { label: 'Info', icon: Info },
}

/**
 * Home screen (master spec §5): the command center and navigation surface. Every number comes from
 * the shared projection through the readiness engine, so all devices agree; every node, alert and
 * tile is a real button that opens the matching screen.
 */
export function Dashboard({ projection, sync, unitName, navigate, onQuickAction, now = systemClock, weights, acknowledgementStorage, canViewActivity = true }: DashboardProps): JSX.Element {
  const current = useClock(now, CLOCK_INTERVAL_MS)
  const [showReadiness, setShowReadiness] = useState(false)
  const [ackStorage] = useState(() => acknowledgementStorage ?? browserAckStorage())
  const breakdown = supplyReadiness(projection, current, { weights, sync })
  const alertList = supplyAlerts(projection, sync, current)
  const next = nextSupplyEvent(projection, current)
  const ami = nextAmiEvent(projection, current)
  const prominence = ami ? amiProminence(ami.days) : 'hidden'
  const amiCard =
    ami && prominence !== 'hidden' ? (
      <AmiReadinessCard event={ami.event} days={ami.days} report={amiReadiness(projection, sync, current)} prominence={prominence} navigate={navigate} />
    ) : null
  const amiOnTop = prominence === 'top' || prominence === 'critical'

  const overdue = upcomingEvents(projection, current).reduce((sum, event) => sum + overdueTasks(event, current).length, 0)
  const outOfStock = projection.inventory.some(item => stockNeedsAttention(item) && item.onHand === 0)
  const nodes: TreeNode[] = [
    {
      id: 'cadets',
      label: 'CADETS',
      value: String(breakdown.cadetsNeedingItems),
      caption: 'NEED ITEMS',
      ariaLabel: `Cadets: ${breakdown.cadetsNeedingItems} ${breakdown.cadetsNeedingItems === 1 ? 'needs' : 'need'} items`,
      tone: breakdown.cadetsNeedingItems ? 'attention' : 'ok',
      activate: () => navigate({ tab: 'more', panel: 'needed' }),
    },
    {
      id: 'stock',
      label: 'STOCK',
      value: String(breakdown.stockNeedingAttention),
      caption: 'NEED ATTENTION',
      ariaLabel: `Stock: ${breakdown.stockNeedingAttention} ${breakdown.stockNeedingAttention === 1 ? 'needs' : 'need'} attention`,
      tone: outOfStock ? 'critical' : breakdown.stockNeedingAttention ? 'attention' : 'ok',
      activate: () => navigate({ tab: 'inventory', filter: 'attention' }),
    },
    {
      id: 'events',
      label: 'EVENTS',
      value: String(breakdown.activePreparations),
      caption: breakdown.activePreparations === 1 ? 'ACTIVE PREPARATION' : 'ACTIVE PREPARATIONS',
      ariaLabel: `Events: ${breakdown.activePreparations} active preparation${breakdown.activePreparations === 1 ? '' : 's'}`,
      tone: overdue ? 'critical' : 'ok',
      activate: () => navigate({ tab: 'calendar' }),
    },
    {
      id: 'readiness',
      label: 'READINESS',
      value: breakdown.overallMeasured ? `${breakdown.overall}%` : '—',
      caption: breakdown.overallMeasured ? 'OVERALL' : 'NOT MEASURED YET',
      ariaLabel: breakdown.overallMeasured ? `Readiness: ${breakdown.overall}% overall` : 'Readiness: not measured yet',
      tone: breakdown.overallMeasured ? readinessTone(breakdown.overall) : 'ok',
      activate: () => setShowReadiness(true),
    },
  ]

  return (
    <div className={`content dashboard${amiCard ? ` has-ami${amiOnTop ? ' ami-top' : ''}` : ''}`}>
      <DashboardHero current={current} unitName={unitName} sync={sync} audit={breakdown.measured.audit ? breakdown.audit : undefined} />

      {amiOnTop && amiCard}

      <section className="dash-actions" aria-label="Quick actions">
        <button type="button" className="dash-action issue" onClick={() => onQuickAction('issue')}>
          <ArrowUpFromLine aria-hidden="true" />
          <span>
            <b>ISSUE</b>
            <small>Hand out gear</small>
          </span>
        </button>
        <button type="button" className="dash-action return" onClick={() => onQuickAction('return')}>
          <ArrowDownToLine aria-hidden="true" />
          <span>
            <b>RETURN</b>
            <small>Take gear back</small>
          </span>
        </button>
        <button type="button" className="dash-action count" onClick={() => onQuickAction('count')}>
          <ClipboardCheck aria-hidden="true" />
          <span>
            <b>COUNT</b>
            <small>Shared count</small>
          </span>
        </button>
      </section>

      <ReadinessTree nodes={nodes} overall={breakdown.overall} openDetails={() => setShowReadiness(true)} />

      <AlertsPanel list={alertList} navigate={navigate} storage={ackStorage} />

      {!amiOnTop && amiCard}

      <section className="dash-panel dash-next" aria-labelledby="dash-next-heading">
        <header className="dash-panel-head">
          <h3 id="dash-next-heading">Next supply event</h3>
        </header>
        {next ? (
          <NextEvent event={next} current={current} open={() => navigate({ tab: 'calendar', calendarEventId: next.calendarEventId })} />
        ) : (
          <div className="dash-empty">
            <CalendarPlus aria-hidden="true" />
            <p>
              <strong>No supply events scheduled</strong>
              <span>
                Add NCO, BLT, AMI, Military Ball and End-of-Year dates — each one comes with its preparation checklist.
              </span>
            </p>
            <button type="button" className="secondary-button" onClick={() => navigate({ tab: 'calendar' })}>
              Open supply calendar
            </button>
          </div>
        )}
      </section>

      <GettingStarted projection={projection} navigate={navigate} />

      <DashboardTiles projection={projection} current={current} navigate={navigate} canViewActivity={canViewActivity} />

      {showReadiness && (
        <ReadinessDrawer
          projection={projection}
          breakdown={breakdown}
          current={current}
          canViewActivity={canViewActivity}
          sync={sync}
          close={() => setShowReadiness(false)}
          navigate={target => {
            setShowReadiness(false)
            navigate(target)
          }}
        />
      )}
    </div>
  )
}

/** audit: undefined while nothing has been recorded (nothing to verify yet). */
function DashboardHero({ current, unitName, sync, audit }: { current: Date; unitName: string; sync: DashboardProps['sync']; audit?: number }) {
  const warn = Boolean(sync.needsFunding) || sync.state === 'error'
  return (
    <header className="dash-hero">
      <div>
        <p className="eyebrow">A.R.G.U.S. COMMAND CENTER</p>
        <h2>{unitName}</h2>
        <div className="dash-status">
          <span className={warn ? 'dash-chip warn' : 'dash-chip'}>
            <Wifi aria-hidden="true" />
            <span className="sr-only">Sync status: </span>
            {sync.label}
          </span>
          {Boolean(sync.queued) && <span className="dash-chip">{sync.queued} waiting to publish</span>}
          <span className="dash-chip">
            <ShieldCheck aria-hidden="true" />
            {audit === undefined ? 'Audit · no records yet' : `Audit ${audit}%`}
          </span>
        </div>
      </div>
      <div className="dash-clock">
        <span className="sr-only">Local time</span>
        <time dateTime={current.toISOString()}>{current.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>
        <span>{current.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</span>
      </div>
    </header>
  )
}

function ReadinessTree({ nodes, overall, openDetails }: { nodes: TreeNode[]; overall: number; openDetails: () => void }) {
  const gradient = `tree-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <section className="dash-tree-card" aria-labelledby={`${gradient}-heading`}>
      <header className="dash-tree-head">
        <p className="eyebrow">LIVE READINESS</p>
        <h3 id={`${gradient}-heading`}>Readiness tree</h3>
      </header>
      <div className="tree-stage">
        <svg className="tree-svg" viewBox={`0 0 ${TREE_WIDTH} ${TREE_HEIGHT}`} aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id={`${gradient}-trunk`} x1="0" y1="1" x2="0" y2="0">
              <stop offset="0" className="tree-stop-gold" />
              <stop offset="1" className="tree-stop-cyan" />
            </linearGradient>
            <radialGradient id={`${gradient}-halo`}>
              <stop offset="0" className="tree-stop-halo" />
              <stop offset="1" className="tree-stop-clear" />
            </radialGradient>
          </defs>
          <circle className="tree-halo" cx="180" cy="44" r="54" fill={`url(#${gradient}-halo)`} />
          {ROOT_PATHS.map(path => (
            <path key={path} className="tree-root" d={path} pathLength={1} />
          ))}
          <path className="tree-trunk" d={TRUNK_PATH} pathLength={1} stroke={`url(#${gradient}-trunk)`} />
          {TWIG_PATHS.map((path, index) => (
            <path key={path} className="tree-twig" d={path} pathLength={1} style={delayStyle(0.9 + index * 0.1)} />
          ))}
          {nodes.map(node => (
            <g key={node.id} className={`tree-limb tone-${node.tone}`}>
              <path className="tree-branch" d={NODE_LAYOUT[node.id].branch} pathLength={1} style={delayStyle(NODE_LAYOUT[node.id].delay)} />
              <path className="tree-flow" d={NODE_LAYOUT[node.id].branch} pathLength={1} />
            </g>
          ))}
          <path className="tree-flow trunk-flow" d={TRUNK_PATH} pathLength={1} />
          <path className="tree-crown" d="M180 30 L187 44 L180 58 L173 44 Z" />
          {SPARKS.map(spark => (
            <circle key={`${spark.x}-${spark.y}`} className="tree-spark" cx={spark.x} cy={spark.y} r="2.2" style={delayStyle(spark.delay)} />
          ))}
        </svg>
        {nodes.map(node => {
          const layout = NODE_LAYOUT[node.id]
          return (
            <button
              key={node.id}
              type="button"
              className={`tree-node tone-${node.tone} side-${layout.side}`}
              style={{ ...place(layout.x, layout.y), ...delayStyle(layout.delay + 0.5) }}
              aria-label={node.ariaLabel}
              onClick={node.activate}
            >
              <span className="tree-node-dot" aria-hidden="true" />
              <small>{node.label}</small> <strong>{node.value}</strong> <span className="tree-node-caption">{node.caption}</span>
              {node.id === 'readiness' && <ReadinessRing percent={overall} />}
            </button>
          )
        })}
        <button
          type="button"
          className="tree-trunk-label"
          style={place(180, 298)}
          aria-label="A.R.G.U.S. supply readiness details"
          onClick={openDetails}
        >
          A.R.G.U.S.
        </button>
      </div>
    </section>
  )
}

function ReadinessRing({ percent }: { percent: number }) {
  return (
    <svg className="tree-ring" viewBox="0 0 36 36" aria-hidden="true" focusable="false">
      <circle className="tree-ring-track" cx="18" cy="18" r="15" pathLength={100} />
      <circle
        className="tree-ring-value"
        cx="18"
        cy="18"
        r="15"
        pathLength={100}
        strokeDasharray={`${Math.max(0, Math.min(100, percent))} 100`}
        transform="rotate(-90 18 18)"
      />
    </svg>
  )
}

function AlertsPanel({ list, navigate, storage }: { list: SupplyAlert[]; navigate: (target: DashboardTarget) => void; storage?: AckStorage }) {
  const id = useId()
  const [showAll, setShowAll] = useState(false)
  const [showAcknowledged, setShowAcknowledged] = useState(false)
  const [acks, setAcks] = useState<Acknowledgements>(() => loadAcknowledgements(storage))
  const open = list.filter(alert => !isAcknowledged(alert, acks))
  const acknowledged = list.filter(alert => isAcknowledged(alert, acks))
  const visible = showAll ? open : open.slice(0, MAX_ALERTS)
  const critical = open.filter(alert => alert.severity === 'critical').length
  // Forget acknowledgements whose condition has cleared, so it alerts again if it comes back.
  const liveIds = list.map(alert => alert.id).join('\n')
  useEffect(() => {
    const stored = loadAcknowledgements(storage)
    const pruned = pruneAcknowledgements(stored, liveIds ? liveIds.split('\n').map(alertId => ({ id: alertId })) : [])
    if (Object.keys(pruned).length !== Object.keys(stored).length) saveAcknowledgements(storage, pruned)
  }, [liveIds, storage])
  const update = (next: Acknowledgements) => {
    const pruned = pruneAcknowledgements(next, list)
    setAcks(pruned)
    saveAcknowledgements(storage, pruned)
  }
  return (
    <section className="dash-panel dash-alerts" aria-labelledby="dash-alerts-heading">
      <header className="dash-panel-head">
        <h3 id="dash-alerts-heading">Alerts</h3>
        {open.length > 0 && (
          <span className={critical ? 'dash-count critical' : 'dash-count'}>
            {critical ? `${critical} critical` : `${open.length} open`}
          </span>
        )}
      </header>
      {open.length ? (
        <ul className="dash-alert-list">
          {visible.map((alert, index) => (
            <AlertRow key={alert.id} alert={alert} titleId={`${id}-open-${index}`} navigate={navigate} action={{ label: 'Acknowledge', run: () => update(acknowledge(acks, alert)) }} />
          ))}
        </ul>
      ) : (
        <p className="dash-all-clear">
          <CircleCheck aria-hidden="true" />
          {acknowledged.length ? 'All clear — every open alert is acknowledged.' : 'All clear — nothing needs attention right now.'}
        </p>
      )}
      {open.length > MAX_ALERTS && (
        <button type="button" className="text-button dash-more" aria-expanded={showAll} onClick={() => setShowAll(value => !value)}>
          {showAll ? 'Show fewer alerts' : `View all ${open.length} alerts`}
        </button>
      )}
      {acknowledged.length > 0 && (
        <>
          <button type="button" className="text-button dash-more" aria-expanded={showAcknowledged} onClick={() => setShowAcknowledged(value => !value)}>
            {showAcknowledged ? 'Hide acknowledged' : `Show acknowledged (${acknowledged.length})`}
          </button>
          {showAcknowledged && (
            <ul className="dash-alert-list acknowledged" aria-label="Acknowledged alerts">
              {acknowledged.map((alert, index) => (
                <AlertRow key={alert.id} alert={alert} titleId={`${id}-ack-${index}`} navigate={navigate} action={{ label: 'Restore', run: () => update(unacknowledge(acks, alert)) }} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}

/** One alert: the whole row opens its record; the side button acknowledges (or restores) it on this device. */
function AlertRow({ alert, titleId, navigate, action }: { alert: SupplyAlert; titleId: string; navigate: (target: DashboardTarget) => void; action: { label: string; run: () => void } }) {
  const Icon = SEVERITY[alert.severity].icon
  return (
    <li className="dash-alert-item">
      <button type="button" className={`dash-alert ${alert.severity}`} onClick={() => navigate(alert.target)}>
        <Icon aria-hidden="true" />
        <span>
          <span className="sr-only">{SEVERITY[alert.severity].label}: </span>
          <strong id={titleId}>{alert.title}</strong>
          <small>{alert.detail}</small>
        </span>
        <ChevronRight aria-hidden="true" />
      </button>
      <button type="button" className="dash-alert-ack" aria-describedby={titleId} title={`${action.label} on this device`} onClick={action.run}>
        <BellOff aria-hidden="true" />
        <span>{action.label}</span>
      </button>
    </li>
  )
}

function NextEvent({ event, current, open }: { event: ArgusAppProjection['calendar'][number]; current: Date; open: () => void }) {
  const progress = eventProgress(event)
  const leaf = dateBlock(event.startsAt)
  const days = daysUntil(event.startsAt, current)
  return (
    <button type="button" className="dash-next-event" onClick={open}>
      <span className="dash-leaf" aria-hidden="true">
        <small>{leaf.month}</small>
        <b>{leaf.day}</b>
      </span>
      <span className="dash-next-body">
        <em>{KIND_LABEL[event.kind]}</em>
        <strong>{event.title}</strong>
        <small>
          {formatDate(event.startsAt)} · {formatTime(event.startsAt)}
        </small>
      </span>
      <span className={days < 0 ? 'dash-countdown past' : 'dash-countdown'}>{countdownLabel(days)}</span>
      <span className="dash-next-progress">
        <span className="dash-meter" aria-hidden="true">
          <span style={{ width: `${progress.percent}%` }} />
        </span>
        <small>
          {progress.total ? `${progress.done}/${progress.total} tasks done` : 'No preparation tasks'}
        </small>
      </span>
    </button>
  )
}

/** Shown to a brand-new unit until its first sizes, cadets and events exist, so an empty dashboard still has a clear next step. */
function GettingStarted({ projection, navigate }: { projection: ArgusAppProjection; navigate: (target: DashboardTarget) => void }) {
  const steps: Array<{ done: boolean; title: string; detail: string; target: DashboardTarget }> = [
    {
      done: projection.inventory.some(item => item.onHand > 0),
      title: 'Stock your inventory',
      detail: 'Add the sizes you carry, then receive or count what is on the shelf.',
      target: { tab: 'inventory' },
    },
    {
      done: projection.cadets.length > 0,
      title: 'Add your cadets',
      detail: 'Cadets are listed by cadet ID; names stay encrypted.',
      target: { tab: 'cadets' },
    },
    {
      done: projection.calendar.some(event => event.active),
      title: 'Schedule supply events',
      detail: 'Enter this year’s NCO, BLT, AMI, Military Ball and End-of-Year dates.',
      target: { tab: 'calendar' },
    },
  ]
  if (steps.every(step => step.done)) return null
  return (
    <section className="dash-panel dash-setup" aria-labelledby="dash-setup-heading">
      <header className="dash-panel-head">
        <h3 id="dash-setup-heading">Set up your unit</h3>
        <span className="dash-count">
          {steps.filter(step => step.done).length}/{steps.length} done
        </span>
      </header>
      <ol>
        {steps.map(step => (
          <li key={step.title}>
            <button type="button" className={step.done ? 'dash-step done' : 'dash-step'} onClick={() => navigate(step.target)}>
              {step.done ? <CircleCheck aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
              <span>
                <strong>{step.title}</strong>
                <small>{step.done ? 'Done' : step.detail}</small>
              </span>
              <ChevronRight aria-hidden="true" />
            </button>
          </li>
        ))}
      </ol>
    </section>
  )
}

function DashboardTiles({ projection, current, navigate, canViewActivity }: { projection: ArgusAppProjection; current: Date; navigate: (target: DashboardTarget) => void; canViewActivity: boolean }) {
  const stocked = projection.inventory.filter(item => item.active && item.onHand > 0).length
  const activeCadets = projection.cadets.filter(cadet => cadet.status === 'ACTIVE').length
  const upcoming = upcomingEvents(projection, current).filter(event => daysUntil(event.startsAt, current) >= 0).length
  const tiles: Array<{ label: string; detail: string; target: DashboardTarget; icon: typeof Boxes }> = [
    { label: 'Inventory', detail: `${stocked} size${stocked === 1 ? '' : 's'} in stock`, target: { tab: 'inventory' }, icon: Boxes },
    { label: 'Cadets', detail: `${activeCadets} active`, target: { tab: 'cadets' }, icon: Users },
    { label: 'Calendar', detail: `${upcoming} upcoming`, target: { tab: 'calendar' }, icon: CalendarRange },
    ...(canViewActivity ? [{ label: 'Activity', detail: `${projection.events.length} record${projection.events.length === 1 ? '' : 's'}`, target: { tab: 'activity' } as DashboardTarget, icon: History }] : []),
    { label: 'Command Center', detail: 'Members, wallet, settings', target: { tab: 'more' }, icon: LayoutGrid },
  ]
  return (
    <nav className="dash-tiles" aria-label="Dashboard navigation">
      {tiles.map(({ label, detail, target, icon: Icon }) => (
        <button type="button" key={label} className="dash-tile" onClick={() => navigate(target)}>
          <span className="dash-tile-icon" aria-hidden="true">
            <Icon />
          </span>
          <span>
            <strong>{label}</strong>
            <small>{detail}</small>
          </span>
        </button>
      ))}
    </nav>
  )
}

type ReadinessRow = {
  key: keyof ReadinessWeights
  label: string
  percent: number
  /** False when the category has nothing to measure yet: shown as "Not measured yet", not as a score. */
  measured: boolean
  explanation: string
  extra?: JSX.Element | string
  link?: string
  target: DashboardTarget
  icon: typeof Users
}

const MAX_LISTED_CADETS = 5

/** Plain words for the audit row: only records mined in a block count as verified. */
function auditExplanation(projection: ArgusAppProjection) {
  const { total, verified, awaitingBlock, notOnChain } = auditSummary(projection)
  if (!total) return 'No changes recorded yet.'
  if (projection.sync.mode === 'local') return `Demo mode: all ${total} recorded changes stay on this device, so none can be verified on a blockchain.`
  const parts = [`${verified} of ${total} recorded changes are verified in a mined block on BSV testnet.`]
  if (awaitingBlock) parts.push(`${awaitingBlock} ${awaitingBlock === 1 ? 'is' : 'are'} shared and waiting for a block.`)
  if (notOnChain) parts.push(`${notOnChain} ${notOnChain === 1 ? 'is' : 'are'} not on chain yet.`)
  return parts.join(' ')
}

function ReadinessDrawer({
  projection,
  breakdown,
  current,
  canViewActivity,
  sync,
  close,
  navigate,
}: {
  projection: ArgusAppProjection
  breakdown: ReadinessBreakdown
  current: Date
  canViewActivity: boolean
  sync: SyncSnapshot
  close: () => void
  navigate: (target: DashboardTarget) => void
}) {
  // Same event the readiness engine scores: the first active event still ahead of now.
  const scored = projection.calendar.find(event => event.calendarEventId === breakdown.scoredEventId)
  const scoredProgress = scored ? eventProgress(scored) : undefined
  const scoredParts = scored ? combinedEventReadiness(scored, projection, current, sync).parts : []
  const missing = breakdown.cadetsNeedingItems ? cadetsMissingStandardIssue(projection) : []
  const weights = breakdown.weights
  const rows: ReadinessRow[] = [
    {
      key: 'cadets',
      label: 'Cadets',
      percent: breakdown.cadets,
      measured: breakdown.measured.cadets,
      explanation: breakdown.activeCadets
        ? `${breakdown.activeCadets - breakdown.cadetsNeedingItems} of ${breakdown.activeCadets} active cadets are fully issued.`
        : 'No active cadets yet — add your roster to track who is fully issued.',
      extra: missing.length ? (
        <ul className="readiness-cadets" aria-label="Cadets missing standard-issue gear">
          {missing.slice(0, MAX_LISTED_CADETS).map(entry => (
            <li key={entry.cadetId}>
              <button type="button" className="text-button" onClick={() => navigate({ tab: 'cadets', cadetId: entry.cadetId })}>
                {entry.label}
                <small>missing {entry.missing.map(item => item.label).join(', ')}</small>
              </button>
            </li>
          ))}
          {missing.length > MAX_LISTED_CADETS && <li className="readiness-cadets-more">and {missing.length - MAX_LISTED_CADETS} more</li>}
        </ul>
      ) : undefined,
      link: 'Open Still Needed',
      target: { tab: 'more', panel: 'needed' },
      icon: Users,
    },
    {
      key: 'inventory',
      label: 'Inventory',
      percent: breakdown.inventory,
      measured: breakdown.measured.inventory,
      explanation: breakdown.inventoryNeeded
        ? `${breakdown.inventoryReady} of ${breakdown.inventoryNeeded} sizes the unit’s bundles need are on hand, above their low-stock level and enough for cadets waiting on them.`
        : 'No bundle defines what to stock yet.',
      link: 'Open items needing attention',
      target: { tab: 'inventory', filter: 'attention' },
      icon: Boxes,
    },
    {
      key: 'events',
      label: 'Events',
      percent: breakdown.events,
      measured: breakdown.measured.events,
      explanation:
        scored && scoredProgress?.total
          ? `${scoredProgress.done} of ${scoredProgress.total} preparation tasks complete for ${scored.title}.`
          : scored
            ? breakdown.measured.events
              ? `${scored.title} has no preparation tasks yet.`
              : `${scored.title} has nothing to prepare yet — add preparation tasks, attendees or bundles.`
            : 'No upcoming supply event — nothing to prepare yet.',
      extra: scoredParts.length > 1 ? `Event readiness combines ${scoredParts.map(part => `${part.label.toLowerCase()} ${part.percent}%`).join(' and ')}.` : undefined,
      link: scored ? `Open ${scored.title}` : 'Open Calendar',
      target: scored ? { tab: 'calendar', calendarEventId: scored.calendarEventId } : { tab: 'calendar' },
      icon: CalendarRange,
    },
    {
      key: 'audit',
      label: 'Audit',
      percent: breakdown.audit,
      measured: breakdown.measured.audit,
      explanation: auditExplanation(projection),
      ...(canViewActivity ? { link: 'Open Activity' } : {}),
      target: { tab: 'activity' },
      icon: ShieldCheck,
    },
  ]
  const equal = rows.every(row => weights[row.key] === weights.cadets)
  return (
    <Drawer title="Supply readiness" icon={<Gauge />} close={close}>
      <section className={`readiness-overall tone-${breakdown.overallMeasured ? readinessTone(breakdown.overall) : 'unmeasured'}`}>
        <strong>{breakdown.overallMeasured ? `${breakdown.overall}%` : 'Not measured yet'}</strong>
        <p>
          Overall supply readiness: the {equal ? 'equal-weighted' : 'weighted'} average of the categories below that have something to measure
          {equal ? '' : ` (${rows.map(row => `${row.label} ×${weights[row.key]}`).join(', ')})`}, computed the same way on every device from the
          unit’s shared records. Weights are set per device in Settings.
        </p>
      </section>
      <ul className="readiness-rows">
        {rows.map(({ key, label, percent, measured, explanation, extra, link, target, icon: Icon }) => (
          <li key={key} className={`tone-${measured ? readinessTone(percent) : 'unmeasured'}`}>
            <div className="readiness-row-head">
              <Icon aria-hidden="true" />
              <strong>{label}</strong>
              <b>{measured ? `${percent}%` : 'Not measured yet'}</b>
            </div>
            <div
              className="dash-meter"
              role="progressbar"
              aria-label={`${label} readiness`}
              aria-valuemin={0}
              aria-valuemax={100}
              {...(measured ? { 'aria-valuenow': percent } : { 'aria-valuetext': 'Not measured yet' })}
            >
              <span style={{ width: `${measured ? percent : 0}%` }} />
            </div>
            <p>{explanation}</p>
            {typeof extra === 'string' ? <p>{extra}</p> : extra}
            {link && (
              <button type="button" className="text-button" onClick={() => navigate(target)}>
                {link} <ChevronRight aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </Drawer>
  )
}
