/**
 * ============================================================================================================
 *  SEVERITY CALIBRATION — READ BEFORE CHANGING ANY CARD BELOW
 * ============================================================================================================
 *  Each scan result has its own card because each means something different to a pharmacist, and the
 *  VISUAL URGENCY MUST MATCH THE REAL URGENCY. Do not "harmonize" these into one template with a colour swap.
 *
 *   verified                 GREEN   calm, low friction      every integrity check passed
 *   stale_version            BLUE    informational, routine  legitimately amended after the QR was printed
 *   tampered                 RED     urgent                  a field changed after issuance (names the field)
 *   forged                   RED     urgent                  the anchored issuance record itself doesn't match
 *   revoked                  RED     urgent                  deliberately withdrawn by the prescriber
 *   provider_identity_issue  ORANGE  identity concern        the prescriber's status is flagged / inactive
 *   unknown_prescription     GREY    neutral but suspicious  no such prescription was ever issued
 *   malformed_qr             GREY    technical, not security the code couldn't be read as an Anchor Rx QR
 *
 *  Rules for future editors:
 *   - Never make stale_version look alarming "for consistency" — it is expected and harmless.
 *   - Never soften tampered / forged / revoked to keep the screen tidy — they must stop the pharmacist.
 *   - tampered and forged are different findings: tampered = "this value was changed"; forged = "the
 *     verification record doesn't match issuance history". Keep their wording distinct.
 *   - provider_identity_issue is about WHO prescribed, not WHAT was prescribed — keep it orange, not red.
 *   - malformed_qr is a reading error; never use security language for it.
 *   - A network/service failure is NOT a scan result and is rendered by ScanServiceError, not here.
 *   - None of these cards is the dispense decision; that is Module 9 (with the AI risk score). Cards state
 *     FINDINGS and next steps only — never "dispense" / "do not dispense" wording derived from scanResult.
 *     The decision slot above the card (TrustDecisionPlaceholder) stays identical for every result.
 *   - The mapping is documented in frontend/doctor-portal/README.md ("Scan result → visual treatment");
 *     update that table in the same change if you alter any card's severity treatment.
 * ============================================================================================================
 */

import type { ComponentType, ReactNode } from 'react';
import {
  Ban,
  CircleCheck,
  CircleHelp,
  FileWarning,
  Info,
  Link2Off,
  RefreshCw,
  ScanLine,
  ShieldAlert,
  UserX,
  type LucideProps,
} from 'lucide-react';
import ChangeList from '../../components/ChangeList';
import type { PrescriptionVersion, QrPayload, ScanResult, VersionDiff } from '../../types';
import { isRevocationDiff } from '../../types';
import TrustDecisionPlaceholder from './TrustDecisionPlaceholder';
import { usePrescriptionDetails } from './usePrescriptionDetails';

export type InputSource = 'camera' | 'manual' | 'follow-up';

interface CardProps {
  result: ScanResult;
  onVerifyPayload: (raw: string) => void;
}

const FIELD_SENTENCES: Record<string, string> = {
  dosage_value: 'Dosage was altered after issuance.',
  dosage_unit: 'Dosage unit was altered after issuance.',
  frequency: 'Frequency was altered after issuance.',
  duration_days: 'Duration was altered after issuance.',
  drug_name: 'Drug name was altered after issuance.',
  drug_class: 'Drug class was altered after issuance.',
  patient_id: 'Patient was altered after issuance.',
  provider_id: 'Prescriber was altered after issuance.',
};

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const formatWhen = (iso: string | null | undefined) => (iso ? dateTime.format(new Date(iso)) : 'unknown time');

// ---------------------------------------------------------------------------------------------------------
// Shared building blocks (layout only — tone is chosen per card)
// ---------------------------------------------------------------------------------------------------------

interface Tone {
  frame: string;
  iconWrap: string;
  title: string;
  body: string;
}

const TONES: Record<'green' | 'blue' | 'red' | 'orange' | 'greySuspicious' | 'greyTechnical', Tone> = {
  green: { frame: 'border-emerald-300 bg-emerald-50', iconWrap: 'bg-emerald-600 text-white', title: 'text-emerald-950', body: 'text-emerald-900' },
  blue: { frame: 'border-sky-200 bg-sky-50', iconWrap: 'bg-sky-100 text-sky-700', title: 'text-sky-950', body: 'text-sky-900' },
  red: { frame: 'border-red-400 bg-red-50 ring-2 ring-red-200', iconWrap: 'bg-red-600 text-white', title: 'text-red-950', body: 'text-red-900' },
  orange: { frame: 'border-orange-400 bg-orange-50 ring-2 ring-orange-100', iconWrap: 'bg-orange-500 text-white', title: 'text-orange-950', body: 'text-orange-900' },
  greySuspicious: { frame: 'border-slate-300 bg-slate-100', iconWrap: 'bg-slate-600 text-white', title: 'text-slate-900', body: 'text-slate-700' },
  greyTechnical: { frame: 'border-slate-200 bg-white', iconWrap: 'bg-slate-100 text-slate-500', title: 'text-slate-800', body: 'text-slate-600' },
};

function ResultShell({
  testId,
  tone,
  icon: Icon,
  eyebrow,
  title,
  lead,
  children,
}: {
  testId: string;
  tone: Tone;
  icon: ComponentType<LucideProps>;
  eyebrow: string;
  title: string;
  lead: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section data-testid={testId} aria-labelledby={`${testId}-title`} className={`rounded-2xl border p-6 shadow-sm ${tone.frame}`}>
      <div className="flex items-start gap-4">
        <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${tone.iconWrap}`}>
          <Icon aria-hidden className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <p className={`text-xs font-semibold uppercase tracking-widest ${tone.body} opacity-80`}>{eyebrow}</p>
          <h2 id={`${testId}-title`} className={`mt-0.5 text-xl font-semibold tracking-tight ${tone.title}`}>
            {title}
          </h2>
          <div className={`mt-1 text-sm leading-relaxed ${tone.body}`}>{lead}</div>
        </div>
      </div>
      {children && <div className="mt-5 space-y-4">{children}</div>}
    </section>
  );
}

function Reference({ result }: { result: ScanResult }) {
  if (!result.prescriptionId) return null;
  return (
    <p className="text-xs text-slate-600">
      Scanned reference <span className="font-mono font-medium text-slate-800">{result.prescriptionId}</span>
      {result.versionNumber !== null && <> · version {result.versionNumber}</>}
    </p>
  );
}

function Summary({ version, patientName }: { version: PrescriptionVersion; patientName?: string }) {
  const rows: Array<[string, ReactNode]> = [
    ['Drug', `${version.drugName} (${version.drugClass})`],
    ['Dose', `${version.dosageValue} ${version.dosageUnit}`],
    ['Frequency', version.frequency],
    ['Duration', `${version.durationDays} days`],
    ['Patient', patientName ? `${patientName} · ${version.patientId}` : version.patientId],
    ['Prescriber', version.providerId],
  ];
  return (
    <dl className="grid gap-x-6 gap-y-2 rounded-xl bg-white/80 p-4 text-sm ring-1 ring-black/5 sm:grid-cols-2" data-testid="prescription-summary">
      {rows.map(([label, value]) => (
        <div key={label} className="flex gap-2">
          <dt className="w-20 shrink-0 text-slate-500">{label}</dt>
          <dd className="font-medium text-slate-900">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DetailsLoading() {
  return <div className="h-24 animate-pulse rounded-xl bg-white/70 ring-1 ring-black/5" aria-label="Loading prescription details" />;
}

function DetailsUnavailable() {
  return <p className="rounded-lg bg-white/70 px-3 py-2 text-xs text-slate-600 ring-1 ring-black/5">Prescription details couldn’t be loaded for display. The scan result above is unaffected.</p>;
}

function CheckRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2">
      <span aria-hidden className={`flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold ${ok ? 'bg-emerald-100 text-emerald-700' : 'bg-red-600 text-white'}`}>
        {ok ? '✓' : '✗'}
      </span>
      <span className={ok ? 'text-slate-700' : 'font-semibold text-red-900'}>{label}</span>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------
// GREEN — verified
// ---------------------------------------------------------------------------------------------------------

function VerifiedCard({ result }: CardProps) {
  const details = usePrescriptionDetails(result.prescriptionId);
  const version = details.status === 'ready' ? details.provenance.versions.find((v) => v.versionNumber === result.versionNumber) : undefined;

  return (
    <ResultShell
      testId="result-verified"
      tone={TONES.green}
      icon={CircleCheck}
      eyebrow="Verified"
      title="Prescription verified"
      lead="Authentic, current and issued by an active prescriber. Every integrity check passed."
    >
      {details.status === 'loading' && <DetailsLoading />}
      {details.status === 'error' && <DetailsUnavailable />}
      {version && details.status === 'ready' && <Summary version={version} patientName={details.patientNames[version.patientId]} />}
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-emerald-900">
        <li>✓ Prescriber active</li>
        <li>✓ Fields match issuance</li>
        <li>✓ Ledger anchor intact</li>
        <li>✓ Current version (v{result.versionNumber})</li>
      </ul>
    </ResultShell>
  );
}

// ---------------------------------------------------------------------------------------------------------
// BLUE — stale_version (informational; deliberately NOT alarming)
// ---------------------------------------------------------------------------------------------------------

function StaleVersionCard({ result, onVerifyPayload }: CardProps) {
  const details = usePrescriptionDetails(result.prescriptionId);
  const current =
    details.status === 'ready' ? details.provenance.versions.find((v) => v.versionNumber === result.currentActiveVersion) : undefined;
  const changes: VersionDiff[] =
    details.status === 'ready'
      ? details.provenance.diffs.filter((d) => d.fromVersion >= (result.versionNumber ?? 0) && d.toVersion <= (result.currentActiveVersion ?? 0))
      : [];

  const verifyCurrent = () => {
    if (!current) return;
    const payload: QrPayload = { prescriptionId: current.prescriptionId, versionNumber: current.versionNumber, issuedAt: new Date(current.createdAt).toISOString() };
    onVerifyPayload(JSON.stringify(payload));
  };

  return (
    <ResultShell
      testId="result-stale_version"
      tone={TONES.blue}
      icon={Info}
      eyebrow="Newer version available"
      title={`Updated to version ${result.currentActiveVersion}`}
      lead={
        <>
          This prescription has since been updated to version {result.currentActiveVersion}. The QR you scanned is for version{' '}
          {result.versionNumber}, issued before a routine amendment. Showing current version details.
        </>
      }
    >
      {details.status === 'loading' && <DetailsLoading />}
      {details.status === 'error' && <DetailsUnavailable />}
      {current && details.status === 'ready' && (
        <>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-sky-800">
              Current version (v{current.versionNumber}) · not yet verified by this scan
            </p>
            <Summary version={current} patientName={details.patientNames[current.patientId]} />
          </div>
          {changes.some((d) => d.changedFields.length > 0) && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-sky-800">What changed since v{result.versionNumber}</p>
              <div className="rounded-xl bg-white/80 px-4 ring-1 ring-black/5">
                <ChangeList changes={changes.flatMap((d) => d.changedFields)} compact />
              </div>
            </div>
          )}
        </>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={verifyCurrent}
          disabled={!current}
          data-testid="verify-current-version"
          className="inline-flex items-center gap-2 rounded-md bg-sky-700 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-800 disabled:opacity-60"
        >
          <RefreshCw aria-hidden className="h-4 w-4" />
          Verify version {result.currentActiveVersion}
        </button>
        <span className="text-xs text-sky-900">Runs the full verification on the current version.</span>
      </div>
    </ResultShell>
  );
}

// ---------------------------------------------------------------------------------------------------------
// RED — tampered (names the altered fields)
// ---------------------------------------------------------------------------------------------------------

function TamperedCard({ result }: CardProps) {
  const fields = result.fieldVerification?.tamperedFields ?? [];
  const unverifiable = Boolean(result.fieldVerification?.unverifiable);

  return (
    <ResultShell
      testId="result-tampered"
      tone={TONES.red}
      icon={ShieldAlert}
      eyebrow="Tampered"
      title="Prescription data was altered"
      lead="Its current contents no longer match what the prescriber issued. Contact the prescriber to confirm what was actually prescribed."
    >
      {fields.length > 0 ? (
        <ul className="space-y-1.5" data-testid="tampered-fields">
          {fields.map((field) => (
            <li key={field} className="flex items-start gap-2 rounded-lg bg-white px-3 py-2 text-base font-semibold text-red-900 ring-1 ring-red-200">
              <FileWarning aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
              <span>
                {FIELD_SENTENCES[field] ?? `${field} was altered after issuance.`}
                <code className="ml-2 font-mono text-xs font-normal text-red-700">{field}</code>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg bg-white px-3 py-2 text-sm font-semibold text-red-900 ring-1 ring-red-200">
          {unverifiable ? 'The stored integrity data for this record is corrupted and could not be checked.' : 'The record no longer matches its integrity data.'}
        </p>
      )}
      <Reference result={result} />
    </ResultShell>
  );
}

// ---------------------------------------------------------------------------------------------------------
// RED — forged (the anchored record itself; phrased differently from tampered)
// ---------------------------------------------------------------------------------------------------------

function ForgedCard({ result }: CardProps) {
  const ledger = result.ledgerVerification;
  return (
    <ResultShell
      testId="result-forged"
      tone={TONES.red}
      icon={Link2Off}
      eyebrow="Forged"
      title="Verification record doesn’t match issuance history"
      lead="This prescription’s verification record does not match the anchor recorded when it was issued, so it cannot be confirmed as genuine. Escalate before relying on this record."
    >
      {ledger && (
        <ul className="space-y-1.5 rounded-xl bg-white p-4 text-sm ring-1 ring-red-200" data-testid="ledger-checks">
          <CheckRow ok={ledger.anchored} label={ledger.anchored ? 'An issuance anchor exists' : 'No issuance anchor exists for this version'} />
          <CheckRow ok={ledger.integrityRootMatch} label={ledger.integrityRootMatch ? 'Matches the anchored issuance record' : 'Does not match the anchored issuance record'} />
          <CheckRow ok={ledger.chainIntact} label={ledger.chainIntact ? 'Issuance history chain is intact' : 'Issuance history chain is broken'} />
        </ul>
      )}
      <Reference result={result} />
    </ResultShell>
  );
}

// ---------------------------------------------------------------------------------------------------------
// RED — revoked (withdrawn by the prescriber)
// ---------------------------------------------------------------------------------------------------------

function RevokedCard({ result }: CardProps) {
  const details = usePrescriptionDetails(result.prescriptionId);
  const revocation =
    details.status === 'ready' ? [...details.provenance.diffs].reverse().find((d) => isRevocationDiff(d)) : undefined;

  return (
    <ResultShell
      testId="result-revoked"
      tone={TONES.red}
      icon={Ban}
      eyebrow="Revoked"
      title="Prescription revoked by the prescriber"
      lead="The prescriber has deliberately withdrawn this prescription. It is no longer an active prescription."
    >
      {details.status === 'loading' && <DetailsLoading />}
      {revocation && isRevocationDiff(revocation) && (
        <p className="rounded-lg bg-white px-3 py-2 text-sm text-red-900 ring-1 ring-red-200" data-testid="revocation-reason">
          <span className="font-semibold">Reason:</span> {revocation.revokedReason ?? 'not recorded'}
          <span className="block text-xs text-red-800">
            Revoked by <span className="font-mono">{revocation.revokedBy ?? 'unknown'}</span> · {formatWhen(revocation.revokedAt)}
          </span>
        </p>
      )}
      <Reference result={result} />
    </ResultShell>
  );
}

// ---------------------------------------------------------------------------------------------------------
// ORANGE — provider_identity_issue (who prescribed, not what)
// ---------------------------------------------------------------------------------------------------------

function ProviderIdentityCard({ result }: CardProps) {
  const details = usePrescriptionDetails(result.prescriptionId);
  const version = details.status === 'ready' ? details.provenance.versions.find((v) => v.versionNumber === result.versionNumber) : undefined;
  const status = result.providerStatus ?? 'not found';

  return (
    <ResultShell
      testId="result-provider_identity_issue"
      tone={TONES.orange}
      icon={UserX}
      eyebrow="Prescriber identity concern"
      title={`The prescribing provider’s status is currently ${status}`}
      lead="The prescriber can’t be confirmed as authorized to issue prescriptions right now. Confirm the prescriber’s identity before proceeding."
    >
      <p className="rounded-lg bg-white px-3 py-2 text-sm text-orange-950 ring-1 ring-orange-200">
        Prescriber <span className="font-mono font-semibold">{version?.providerId ?? '…'}</span> · status{' '}
        <span className="font-semibold uppercase">{status}</span>
        <span className="block text-xs text-orange-900">Identity is checked first, so field and ledger checks were not run for this scan.</span>
      </p>
      <Reference result={result} />
    </ResultShell>
  );
}

// ---------------------------------------------------------------------------------------------------------
// GREY — unknown_prescription (never existed; suspicious, not a failed real prescription)
// ---------------------------------------------------------------------------------------------------------

function UnknownPrescriptionCard({ result }: CardProps) {
  return (
    <ResultShell
      testId="result-unknown_prescription"
      tone={TONES.greySuspicious}
      icon={CircleHelp}
      eyebrow="Not found"
      title="No such prescription exists"
      lead="This QR is correctly formatted, but it points to a prescription that was never issued through Anchor Rx. It may be fabricated or from another system."
    >
      <Reference result={result} />
    </ResultShell>
  );
}

// ---------------------------------------------------------------------------------------------------------
// GREY — malformed_qr (technical reading error; no security language)
// ---------------------------------------------------------------------------------------------------------

function MalformedQrCard() {
  return (
    <ResultShell
      testId="result-malformed_qr"
      tone={TONES.greyTechnical}
      icon={ScanLine}
      eyebrow="Couldn’t read code"
      title="This isn’t a readable Anchor Rx QR code"
      lead="The scanned data couldn’t be read as a prescription reference — the code may be damaged, partly captured, or from a different app. Try scanning again, or paste the payload."
    />
  );
}

const CARDS: Record<ScanResult['scanResult'], ComponentType<CardProps>> = {
  verified: VerifiedCard,
  stale_version: StaleVersionCard,
  tampered: TamperedCard,
  forged: ForgedCard,
  revoked: RevokedCard,
  provider_identity_issue: ProviderIdentityCard,
  unknown_prescription: UnknownPrescriptionCard,
  malformed_qr: MalformedQrCard,
};

export default function ScanResultView({
  result,
  source,
  onVerifyPayload,
  onScanAnother,
}: {
  result: ScanResult;
  source: InputSource;
  onVerifyPayload: (raw: string) => void;
  onScanAnother: () => void;
}) {
  const Card = CARDS[result.scanResult];
  if (!Card) {
    return (
      <p role="alert" className="rounded-lg border border-slate-300 bg-white p-4 text-sm">
        Unrecognized scan result <code className="font-mono">{String(result.scanResult)}</code>.
      </p>
    );
  }

  return (
    <div className="space-y-3" data-testid="scan-result" data-scan-result={result.scanResult}>
      <TrustDecisionPlaceholder />
      <Card key={`${result.prescriptionId}:${result.versionNumber}:${result.scannedAt}`} result={result} onVerifyPayload={onVerifyPayload} />
      <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-xs text-slate-500">
        <span>
          Scanned {formatWhen(result.scannedAt)} via{' '}
          {source === 'camera' ? 'camera' : source === 'follow-up' ? 'current-version check' : 'manual paste'}
        </span>
        <button type="button" onClick={onScanAnother} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100">
          Scan another
        </button>
      </div>
    </div>
  );
}
