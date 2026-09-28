import { useId, useState } from 'react'
import { ChevronDown, Lock, Pencil, Plus, Shirt } from 'lucide-react'
import { Drawer } from '../../components/Drawer'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { ArgusPermission } from '../../distributed/types'
import { BundleForm } from './BundleForm'
import { APPLICABILITY, activeSizeCount, currentVersionOf, isDefaultPreset, lineReady, versionChanges } from './bundleModel'
import './bundles.css'
import { plural } from '../../plural'

export type BundleEditorPanelProps = {
  projection: ArgusAppProjection
  controller: DistributedAppController
  can: (permission: ArgusPermission) => boolean
  memberName: (publicIdentity: string) => string
  onProjection: (projection: ArgusAppProjection) => void
  notify: (message: string) => void
  close: () => void
}

type Bundle = ArgusAppProjection['bundles'][number]
type Mode = { kind: 'list' } | { kind: 'edit'; bundleId: string } | { kind: 'new' }

const formatDate = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleDateString()
}
const applicabilityLabel = (value: string) => APPLICABILITY.find(option => option.value === value)?.label ?? value

/**
 * Issue bundles (master spec §8–9): the default presets plus the unit's own, each with its full
 * version history. People with bundles.manage edit a bundle by saving a new version; nothing in an
 * earlier version or a past issue is rewritten.
 */
export function BundleEditorPanel({ projection, controller, can, memberName, onProjection, notify, close }: BundleEditorPanelProps) {
  const [mode, setMode] = useState<Mode>({ kind: 'list' })
  const [expanded, setExpanded] = useState<string>()
  const canManage = can('bundles.manage')
  const editing = mode.kind === 'edit' ? projection.bundles.find(bundle => bundle.bundleId === mode.bundleId) : undefined
  const showForm = canManage && (mode.kind === 'new' || Boolean(editing))

  return (
    <Drawer title="Issue bundles" icon={<Shirt />} close={close}>
      {showForm ? (
        <BundleForm
          key={mode.kind === 'edit' ? mode.bundleId : 'new'}
          projection={projection}
          controller={controller}
          bundle={editing}
          onCancel={() => setMode({ kind: 'list' })}
          onSaved={(next, bundleId, message) => {
            onProjection(next)
            notify(message)
            setExpanded(bundleId)
            setMode({ kind: 'list' })
          }}
        />
      ) : (
        <>
          <div className="bundle-panel-intro">
            <p>Each change to a bundle is saved as a new version. Earlier versions and every past issue keep the contents they had.</p>
            {canManage ? (
              <button type="button" className="secondary-button bundle-new-button" onClick={() => setMode({ kind: 'new' })}>
                <Plus aria-hidden="true" /> New bundle
              </button>
            ) : (
              <p className="safe-note bundle-readonly">
                <Lock aria-hidden="true" /> Read only. A Supply Officer or the Master edits bundles.
              </p>
            )}
          </div>
          <div className="bundle-list">
            {projection.bundles.map(bundle => (
              <BundleCard
                key={bundle.bundleId}
                bundle={bundle}
                projection={projection}
                memberName={memberName}
                open={expanded === bundle.bundleId}
                toggle={() => setExpanded(current => (current === bundle.bundleId ? undefined : bundle.bundleId))}
                onEdit={canManage ? () => setMode({ kind: 'edit', bundleId: bundle.bundleId }) : undefined}
              />
            ))}
          </div>
        </>
      )}
    </Drawer>
  )
}

function BundleCard({ bundle, projection, memberName, open, toggle, onEdit }: { bundle: Bundle; projection: ArgusAppProjection; memberName: (publicIdentity: string) => string; open: boolean; toggle: () => void; onEdit?: () => void }) {
  const ids = useId()
  const current = currentVersionOf(bundle)
  const lines = [...current.lines].sort((a, b) => a.order - b.order)
  const ready = lines.filter(line => lineReady(line, projection.inventory)).length
  const history = [...bundle.versions].sort((a, b) => b.version - a.version)
  const issuesWith = (version: number) => projection.transactions.filter(transaction => transaction.bundleId === bundle.bundleId && transaction.bundleVersion === version).length

  return (
    <article className={current.active ? 'bundle-card' : 'bundle-card bundle-card-inactive'} aria-labelledby={`${ids}-name`}>
      <div className="bundle-card-head">
        <button type="button" className="bundle-card-toggle" aria-expanded={open} aria-controls={`${ids}-body`} onClick={toggle}>
          <span className="bundle-card-title">
            <strong id={`${ids}-name`}>{current.displayName}</strong>
            <small>
              {applicabilityLabel(current.genderApplicability)} · {current.purpose || 'No purpose set'} · v{bundle.currentVersion}
            </small>
          </span>
          <span className="bundle-card-meta">
            <em className={`status-badge ${current.active ? 'success' : ''}`}>{current.active ? 'Active' : 'Inactive'}</em>
            <small>
              {ready}/{lines.length} lines ready
            </small>
          </span>
          <ChevronDown className="bundle-card-chevron" aria-hidden="true" />
        </button>
        {onEdit && (
          <button type="button" className="secondary-button bundle-edit-button" aria-label={`Edit ${current.displayName}`} onClick={onEdit}>
            <Pencil aria-hidden="true" /> Edit
          </button>
        )}
      </div>
      {open && (
        <div className="bundle-card-body" id={`${ids}-body`}>
          <h4>Lines in v{bundle.currentVersion}</h4>
          <ul className="bundle-card-lines">
            {lines.map(line => {
              const lineIsReady = lineReady(line, projection.inventory)
              const sizes = activeSizeCount(line, projection.inventory)
              return (
                <li key={line.lineId}>
                  <span>
                    <b>{line.displayLabel}</b>
                    <small>
                      {line.required ? 'Required' : 'Optional'} · ×{line.defaultQuantity} · {line.supportsSizing ? 'Sized' : 'One size'}
                    </small>
                  </span>
                  <em className={`status-badge ${lineIsReady ? 'success' : 'warning'}`}>{lineIsReady ? `${plural(sizes, 'size')} active` : 'No sizes yet'}</em>
                </li>
              )
            })}
          </ul>
          <h4>Version history</h4>
          <ol className="bundle-history" aria-label={`${current.displayName} version history`}>
            {history.map(version => {
              const issues = issuesWith(version.version)
              const changes = versionChanges(
                bundle.versions.find(candidate => candidate.version === version.version - 1),
                version,
              )
              return (
                <li key={version.version}>
                  <strong>
                    v{version.version}
                    {version.version === bundle.currentVersion ? ' · Current' : ''}
                  </strong>
                  <small>
                    {isDefaultPreset(version) ? 'Default preset' : `${formatDate(version.createdAt)} · ${memberName(version.actorPublicIdentity)}`} · {plural(version.lines.length, 'line')}
                    {issues ? ` · used in ${plural(issues, 'issue')}` : ''}
                  </small>
                  {changes.length > 0 && <small className="bundle-history-changes">{changes.join(' · ')}</small>}
                </li>
              )
            })}
          </ol>
          {bundle.versions.length > 1 && <p className="bundle-hint">Past issues keep the version they were made with.</p>}
        </div>
      )}
    </article>
  )
}
