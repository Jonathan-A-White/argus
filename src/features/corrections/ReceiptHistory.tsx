import { useState } from 'react'
import { PencilLine } from 'lucide-react'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { InventoryProjection } from '../../distributed/types'
import { memberLabel } from '../cadets/cadetDisplay'
import { RecordCorrectionForm } from './RecordCorrectionForm'
import { receiptsFor, sizeLabel } from './correctionModel'
import './corrections.css'

const formatDate = (iso: string) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleDateString() }

/** Stock receipts for one catalog item's sizes, each correctable (RECEIPT_QUANTITY) by people with inventory.adjust. */
export function ReceiptHistory({ variants, projection, controller, canCorrect, onProjection, notify }: { variants: InventoryProjection[]; projection: ArgusAppProjection; controller: DistributedAppController; canCorrect: boolean; onProjection: (projection: ArgusAppProjection) => void; notify: (message: string) => void }) {
  const [correcting, setCorrecting] = useState<string>()
  const receipts = receiptsFor(projection, variants.map(variant => variant.entityId))
  if (!receipts.length) return null
  const name = variants[0]?.name ?? 'item'
  return (
    <section className="receipt-history" aria-label="Received stock">
      <h3>Received stock</h3>
      {receipts.map(receipt => {
        const title = `receipt of ${receipt.recorded} × ${name} · ${sizeLabel(receipt.variant)} on ${formatDate(receipt.at)}`
        return (
          <div key={receipt.eventId} className="receipt-row">
            <div className="needed-row">
              <span>
                <strong>{sizeLabel(receipt.variant)} · {receipt.quantity} received{receipt.quantity !== receipt.recorded ? ` (corrected from ${receipt.recorded})` : ''}</strong>
                <small>{formatDate(receipt.at)} · {memberLabel(projection, receipt.actor)}{receipt.note ? ` · ${receipt.note}` : ''}</small>
              </span>
              {canCorrect && correcting !== receipt.eventId && (
                <button type="button" className="secondary-button record-correct-button" aria-label={`Correct ${title}`} onClick={() => setCorrecting(receipt.eventId)}>
                  <PencilLine aria-hidden="true" /> Correct…
                </button>
              )}
            </div>
            {correcting === receipt.eventId && (
              <RecordCorrectionForm
                title={title}
                targets={[{ kind: 'RECEIPT_QUANTITY', targetEventId: receipt.eventId, label: `${name} · ${sizeLabel(receipt.variant)} received`, recorded: receipt.quantity }]}
                controller={controller}
                onCancel={() => setCorrecting(undefined)}
                onCorrected={(next, summary) => { setCorrecting(undefined); onProjection(next); notify(`Receipt corrected: ${summary}.`) }}
              />
            )}
          </div>
        )
      })}
    </section>
  )
}
