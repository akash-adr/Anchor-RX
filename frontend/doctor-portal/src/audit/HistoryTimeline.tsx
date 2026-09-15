import { Fragment, type ComponentType, type ReactNode } from 'react';
import { Ban, FilePen, FilePlus2, Link2, Pill, Scale, ScanLine, type LucideProps } from 'lucide-react';
import type { AuditEvent, AuditMedicineSnapshot, AuditTimeline, AuditTrustDecision, PharmacyScanEvent } from '../types';
import { Chip, DECISION_STYLE, SCAN_RESULT_STYLE, STATUS_STYLE, formatEpoch, shortHash, utcIso } from './auditUi';

/**
 * HISTORY — the immutable, recorded audit trail from GET /api/audit/prescriptions/:id/timeline, oldest first.
 * Rendered exactly as recorded: nothing here is rechecked or re-derived (the live recheck is CurrentIntegrityCard,
 * in its own section above). Each event type has its own visual treatment, and a pharmacy scan's trust decision is
 * nested INSIDE its scan card (linked server-side by verification_event_id) — never a separate entry to reconnect.
 */

const EVENT_STYLE: Record<AuditEvent['eventType'], { label: string; icon: ComponentType<LucideProps>; card: string; badge: string }> = {
  version_created: { label: 'Prescription created', icon: FilePlus2, card: 'border-teal-200 bg-white', badge: 'bg-teal-600 text-white' },
  version_amended: { label: 'Prescription amended', icon: FilePen, card: 'border-violet-200 bg-violet-50/50', badge: 'bg-violet-600 text-white' },
  version_revoked: { label: 'Prescription revoked', icon: Ban, card: 'border-rose-300 bg-rose-50/70', badge: 'bg-rose-700 text-white' },
  ledger_anchored: { label: 'Anchored to ledger', icon: Link2, card: 'border-slate-300 bg-slate-50', badge: 'bg-slate-700 text-white' },
  pharmacy_scan: { label: 'Pharmacy scan', icon: ScanLine, card: 'border-sky-200 bg-white', badge: 'bg-sky-600 text-white' },
  medicine_dispensed: { label: 'Medicine dispensed', icon: Pill, card: 'border-emerald-200 bg-emerald-50/40', badge: 'bg-emerald-700 text-white' },
};

function eventKey(event: AuditEvent, index: number): string {
  if (event.eventType === 'pharmacy_scan') return `scan-${event.detail.eventId}`;
  if (event.eventType === 'ledger_anchored') return `ledger-${event.detail.ledgerEntryId}`;
  if (event.eventType === 'medicine_dispensed') return `dispensed-${event.detail.dispensingId}`;
  return `${event.eventType}-${event.versionNumber}-${index}`;
}

export default function HistoryTimeline({ data }: { data: AuditTimeline }) {
  return (
    <div className="space-y-4">
      <p className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
        {data.timeline.length} recorded event{data.timeline.length === 1 ? '' : 's'} · latest recorded version status
        <Chip className={STATUS_STYLE[data.currentStatus]}>{data.currentStatus}</Chip>
      </p>

      <ol data-testid="history-timeline" className="relative space-y-4 border-l-2 border-slate-200 pl-6">
        {data.timeline.map((event, index) => (
          <li key={eventKey(event, index)} className="relative">
            <span aria-hidden className={`absolute -left-[33px] top-5 h-4 w-4 rounded-full border-2 border-slate-50 ${EVENT_STYLE[event.eventType].badge}`} />
            <EventCard event={event} />
          </li>
        ))}
      </ol>

      {data.unlinkedTrustDecisions.length > 0 && (
        <section className="rounded-xl border border-amber-300 bg-amber-50 p-4">
          <h3 className="text-sm font-semibold text-amber-950">Trust decisions not linked to a scan on this timeline</h3>
          <ul className="mt-2 space-y-2">
            {data.unlinkedTrustDecisions.map((decision) => (
              <li key={decision.decisionId}>
                <TrustDecisionBody decision={decision} />
                <p className="text-xs text-amber-800">verification event {decision.verificationEventId ?? 'none'}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function EventCard({ event }: { event: AuditEvent }) {
  const style = EVENT_STYLE[event.eventType];
  const Icon = style.icon;
  return (
    <article data-testid={`event-${event.eventType}`} className={`rounded-xl border p-4 shadow-sm ${style.card}`}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${style.badge}`}>
          <Icon aria-hidden className="h-4 w-4" />
        </span>
        <h3 className="font-semibold text-slate-900">{style.label}</h3>
        <Chip className="bg-white text-slate-700 ring-slate-300">v{event.versionNumber}</Chip>
        <time dateTime={utcIso(event.timestamp)} title={`UTC ${utcIso(event.timestamp)}`} className="ml-auto font-mono text-xs text-slate-500">
          {formatEpoch(event.timestamp)}
        </time>
      </header>
      <div className="mt-3 text-sm">
        <EventDetail event={event} />
      </div>
    </article>
  );
}

function Facts({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[max-content_1fr]">
      {items.map(([label, value]) => (
        <Fragment key={label}>
          <dt className="text-slate-500">{label}</dt>
          <dd className="min-w-0 break-words text-slate-900">{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

const mono = (value: string) => <span className="font-mono text-xs">{value}</span>;

function MedicineList({ medicines }: { medicines: AuditMedicineSnapshot[] }) {
  return (
    <ol className="space-y-0.5">
      {medicines.map((m) => (
        <li key={m.sequenceNumber}>
          <span className="text-slate-400">{m.sequenceNumber}.</span> <span className="font-medium">{m.drugName}</span>{' '}
          <span className="text-slate-500">({m.drugClass})</span> — {m.dosageValue} {m.dosageUnit}, {m.frequency}, {m.durationDays} days, qty{' '}
          {m.quantityPrescribed}
        </li>
      ))}
    </ol>
  );
}

const vital = (value: string | null, unit: string) => (value ? `${value} ${unit}` : 'not recorded');
const hash = (value: string) => (
  <span className="font-mono text-xs" title={value}>
    {shortHash(value)}
  </span>
);

function EventDetail({ event }: { event: AuditEvent }) {
  switch (event.eventType) {
    case 'version_created': {
      const d = event.detail;
      return (
        <Facts
          items={[
            ['Medicines', <MedicineList medicines={d.medicines} />],
            ['Height', vital(d.heightCm, 'cm')],
            ['Weight', vital(d.weightKg, 'kg')],
            ['Route', d.route],
            ['Prescriber', mono(d.providerId)],
            ['Integrity root', hash(d.integrityRoot)],
          ]}
        />
      );
    }
    case 'version_amended': {
      const d = event.detail;
      return (
        <div className="space-y-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-violet-800">Changed from v{d.fromVersion}</p>
            <ul className="mt-1 space-y-1">
              {d.changedFields.map((change, index) => (
                <li key={`${change.medicine ?? 0}-${change.field}-${index}`} className="flex flex-wrap items-center gap-2">
                  {change.medicine !== undefined && (
                    <span className="text-xs font-semibold text-violet-900">
                      Medicine {change.medicine}
                      {change.drugName ? ` · ${change.drugName}` : ''}
                    </span>
                  )}
                  <code className="rounded bg-violet-100 px-1.5 py-0.5 font-mono text-xs text-violet-900">{change.field}</code>
                  <span className="text-slate-500 line-through">{String(change.old ?? '—')}</span>
                  <span aria-hidden>→</span>
                  <span className="font-semibold text-slate-900">
                    {String(change.new ?? '—')}
                    {change.unit ? ` ${change.unit}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <Facts
            items={[
              ['Amended by', d.amendedBy ? mono(d.amendedBy) : 'unknown'],
              ['Reason', d.reason ?? '—'],
              ['Medicines now', <MedicineList medicines={d.medicines} />],
              ['Integrity root', hash(d.integrityRoot)],
            ]}
          />
        </div>
      );
    }
    case 'version_revoked': {
      const d = event.detail;
      return (
        <Facts
          items={[
            ['Revoked version', `v${d.fromVersion} → v${event.versionNumber} (terminal)`],
            ['Revoked by', d.revokedBy ? mono(d.revokedBy) : 'unknown'],
            ['Reason', d.revokedReason ?? '—'],
          ]}
        />
      );
    }
    case 'ledger_anchored': {
      const d = event.detail;
      return (
        <Facts
          items={[
            ['Global chain position', <span className="font-mono text-xs">#{d.chainPosition}</span>],
            ['Entry hash', hash(d.entryHash)],
            ['Previous entry hash', d.previousEntryHash ? hash(d.previousEntryHash) : 'none (first ledger entry)'],
            ['Anchored integrity root', hash(d.integrityRoot)],
            ['Anchor type', d.anchorType],
          ]}
        />
      );
    }
    case 'pharmacy_scan':
      return <ScanDetail event={event} />;
    case 'medicine_dispensed': {
      const d = event.detail;
      return (
        <Facts
          items={[
            ['Medicine', `${d.drugName} (medicine ${d.sequenceNumber})`],
            ['Quantity dispensed', <span className="font-mono">{d.quantityDispensed}</span>],
            ['Pharmacy', mono(d.pharmacyId)],
            ['Dispensing record', mono(`#${d.dispensingId}`)],
          ]}
        />
      );
    }
  }
}

function ScanDetail({ event }: { event: PharmacyScanEvent }) {
  const result = SCAN_RESULT_STYLE[event.detail.scanResult];
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Chip className={result.chip}>{result.label}</Chip>
        <span className="text-slate-600">
          at pharmacy {mono(event.detail.pharmacyId)} · scan event #{event.detail.eventId} · QR pointed at v{event.versionNumber}
        </span>
      </div>

      {event.trustDecision ? (
        <div data-testid="nested-trust-decision" className="mt-3 ml-2 border-l-4 border-slate-300 pl-4">
          <div className={`rounded-lg border px-3 py-3 ${DECISION_STYLE[event.trustDecision.trustDecision].frame}`}>
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-slate-600">
              <Scale aria-hidden className="h-3.5 w-3.5" />
              Trust decision for this scan
            </p>
            <TrustDecisionBody decision={event.trustDecision} scannedVersion={event.versionNumber} />
          </div>
        </div>
      ) : (
        <p className="mt-3 ml-2 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-xs text-slate-500">No trust decision was logged for this scan.</p>
      )}
    </div>
  );
}

function TrustDecisionBody({ decision, scannedVersion }: { decision: AuditTrustDecision; scannedVersion?: number }) {
  const evaluatedElsewhere = scannedVersion !== undefined && decision.evaluatedVersionNumber !== null && decision.evaluatedVersionNumber !== scannedVersion;
  return (
    <div className="mt-1.5 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Chip className={DECISION_STYLE[decision.trustDecision].chip}>{decision.trustDecision}</Chip>
        <code className="font-mono text-xs text-slate-700">{decision.primaryReason}</code>
        <span className="text-xs text-slate-600">{decision.riskScore !== null ? `risk ${decision.riskScore} · ${decision.riskBand}` : 'no risk score'}</span>
      </div>
      <p className="text-xs text-slate-500">
        Decided{' '}
        <time dateTime={utcIso(decision.decidedAt)} title={`UTC ${utcIso(decision.decidedAt)}`} className="font-mono">
          {formatEpoch(decision.decidedAt)}
        </time>{' '}
        at {decision.pharmacyId}
        {evaluatedElsewhere && ` · risk evaluated on the current version v${decision.evaluatedVersionNumber} (the QR pointed at v${scannedVersion})`}
      </p>
    </div>
  );
}
