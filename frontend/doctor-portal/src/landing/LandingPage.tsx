import { useEffect, type ComponentType, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  ArrowRight,
  BrainCircuit,
  Fingerprint,
  History,
  Link2,
  Pill,
  ScanLine,
  ShieldCheck,
  Stethoscope,
  type LucideProps,
} from 'lucide-react';
import './landing.css';

const PORTAL_PATH = '/portal';
const PHARMACY_PATH = '/pharmacy';
const AUDIT_PATH = '/audit';

function PortalButton({ className = '' }: { className?: string }) {
  return (
    <Link
      to={PORTAL_PATH}
      className={`inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-teal-700 px-7 py-3.5 text-base font-semibold text-white shadow-lg shadow-teal-900/15 transition hover:bg-teal-800 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-teal-600 ${className}`}
    >
      Enter Doctor Portal
      <ArrowRight aria-hidden className="h-5 w-5" />
    </Link>
  );
}

function PharmacyButton({ className = '' }: { className?: string }) {
  return (
    <Link
      to={PHARMACY_PATH}
      className={`inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-teal-700/30 bg-white px-6 py-3.5 text-base font-semibold text-teal-800 shadow-sm transition hover:border-teal-700 hover:bg-teal-50 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-teal-600 ${className}`}
    >
      <Pill aria-hidden className="h-5 w-5" />
      Pharmacy Login
    </Link>
  );
}

/**
 * ⚠ Prototype: this link IS the whole "gate" into the Audit Dashboard — a click-through with no auditor identity,
 * login or access control (even more minimal than the Doctor/Pharmacy mock logins). See audit/AuditLayout.tsx.
 */
function AuditButton({ className = '' }: { className?: string }) {
  return (
    <Link
      to={AUDIT_PATH}
      className={`inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-slate-300 bg-white px-6 py-3.5 text-base font-semibold text-slate-800 shadow-sm transition hover:border-slate-700 hover:bg-slate-100 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-teal-600 ${className}`}
    >
      <History aria-hidden className="h-5 w-5" />
      Enter Audit Dashboard
    </Link>
  );
}

function SectionHeading({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="text-sm font-semibold uppercase tracking-widest text-teal-700">{eyebrow}</p>
      <h2 id={id} className="mt-2 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">{title}</h2>
      {children && <p className="mt-4 text-base leading-relaxed text-slate-600">{children}</p>}
    </div>
  );
}

type Icon = ComponentType<LucideProps>;

const STEPS: Array<{ icon: Icon; title: string; line: string }> = [
  { icon: Stethoscope, title: 'Doctor creates', line: 'A prescription is entered and authorized in the Doctor Portal.' },
  { icon: Fingerprint, title: 'Hashed + risk-scored', line: 'Every field is SHA-256 hashed; an AI model scores how unusual it is.' },
  { icon: Link2, title: 'Anchored + QR issued', line: 'The integrity root is anchored to the ledger; the QR holds only a reference.' },
  { icon: ScanLine, title: 'Pharmacy scans', line: 'Provider, field hashes, ledger anchor and version are re-verified.' },
  { icon: ShieldCheck, title: 'Dispense / Review / Block', line: 'A clear outcome with the exact reason behind it.' },
];

const FEATURES: Array<{ icon: Icon; title: string; body: ReactNode }> = [
  {
    icon: Fingerprint,
    title: 'Field-Level Integrity',
    body: 'Every field is hashed independently — the system can prove exactly which value changed, not just that something did.',
  },
  {
    icon: BrainCircuit,
    title: 'AI Risk Signals',
    body: 'An anomaly model flags unusual-but-authentic prescriptions for human review, with clear explainable reasons.',
  },
  {
    icon: Link2,
    title: 'Ledger-Anchored',
    body: (
      <>
        Integrity roots are anchored to a separate append-only, hash-chained ledger — so even a database edit that rewrites the
        stored hash no longer matches the anchor.{' '}
        <span className="text-slate-500">(A mock ledger in this prototype, designed to move to an external chain.)</span>
      </>
    ),
  },
  {
    icon: History,
    title: 'Full Provenance',
    body: 'Every amendment creates a new version — nothing is silently overwritten, and the full history stays auditable.',
  },
];

export default function LandingPage() {
  useEffect(() => {
    document.title = 'Anchor Rx — Tamper-evident prescriptions';
  }, []);

  return (
    <div className="landing-font min-h-screen bg-white text-slate-900">
      {/* Hero */}
      <header className="relative overflow-hidden bg-gradient-to-b from-white via-teal-50/40 to-sky-50/70 px-4 pb-20 pt-10 sm:px-6 sm:pt-14">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-[36rem] bg-[radial-gradient(ellipse_at_50%_35%,rgba(13,148,136,0.07),transparent_65%)]"
        />
        <div className="relative mx-auto flex max-w-5xl flex-col items-center text-center">
          <h1 data-testid="hero-wordmark" className="landing-wordmark landing-rise-in mt-12 sm:mt-20">
            Anchor Rx
          </h1>
          <p
            data-testid="hero-tagline"
            className="landing-rise-in landing-rise-in-delayed mt-5 max-w-2xl text-balance text-lg font-light leading-relaxed text-slate-600 sm:text-2xl"
          >
            Trust what was prescribed. Detect what was changed. Flag what deserves review.
          </p>
          <p className="mt-4 max-w-xl text-base text-slate-600">
            A tamper-evident prescription integrity and safety network for doctors and pharmacies.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <PortalButton />
            <PharmacyButton />
            <AuditButton />
          </div>
        </div>
      </header>

      <main>
        {/* What is Anchor Rx */}
        <section aria-labelledby="what-title" className="px-4 py-20 sm:px-6">
          <div className="mx-auto max-w-5xl">
            <div className="mx-auto max-w-3xl text-center">
              <p className="text-sm font-semibold uppercase tracking-widest text-teal-700">What is Anchor Rx</p>
              <h2 id="what-title" className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
                Prescriptions you can prove, not just trust
              </h2>
              <p className="mt-5 text-lg leading-relaxed text-slate-600">
                Anchor Rx is a tamper-evident digital prescription platform. Field-level SHA-256 hashing and ledger anchoring make
                sure a prescription can’t be silently altered without being detected, while an AI anomaly model flags prescriptions
                that are authentic but unusual enough to deserve a second look.
              </p>
            </div>

            <figure className="mx-auto mt-12 grid max-w-4xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm sm:grid-cols-2">
              <blockquote className="flex items-start gap-4 border-b border-slate-200 p-7 sm:border-b-0 sm:border-r">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-teal-700">
                  <ShieldCheck aria-hidden className="h-6 w-6" />
                </span>
                <p className="text-xl font-semibold leading-snug tracking-tight sm:text-2xl">
                  Blockchain answers: <span className="text-teal-700">was it changed?</span>
                </p>
              </blockquote>
              <blockquote className="flex items-start gap-4 p-7">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-600">
                  <BrainCircuit aria-hidden className="h-6 w-6" />
                </span>
                <p className="text-xl font-semibold leading-snug tracking-tight sm:text-2xl">
                  AI answers: <span className="text-amber-600">does it deserve attention?</span>
                </p>
              </blockquote>
              <figcaption className="border-t border-slate-200 bg-slate-50 px-7 py-3 text-center text-sm text-slate-500 sm:col-span-2">
                Decision support for pharmacists — never autonomous clinical judgment.
              </figcaption>
            </figure>
          </div>
        </section>

        {/* How it works */}
        <section aria-labelledby="how-title" className="border-y border-slate-200 bg-slate-50/70 px-4 py-20 sm:px-6">
          <div className="mx-auto max-w-6xl">
            <div className="mx-auto max-w-2xl text-center">
              <p className="text-sm font-semibold uppercase tracking-widest text-teal-700">How it works</p>
              <h2 id="how-title" className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
                From prescription to pharmacy counter
              </h2>
            </div>

            <ol className="mt-12 grid gap-4 lg:grid-cols-5 lg:gap-3">
              {STEPS.map(({ icon: StepIcon, title, line }, index) => (
                <li key={title} className="relative flex gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm lg:flex-col lg:gap-3">
                  <div className="flex items-center gap-3">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-teal-700 text-white">
                      <StepIcon aria-hidden className="h-5 w-5" />
                    </span>
                    <span className="hidden font-mono text-xs font-semibold text-slate-400 lg:inline">0{index + 1}</span>
                  </div>
                  <div>
                    <h3 className="font-semibold leading-snug">{title}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-slate-600">{line}</p>
                    {index === STEPS.length - 1 && (
                      <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] font-semibold uppercase tracking-wide">
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-800">Dispense</span>
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800">Review</span>
                        <span className="rounded-full bg-red-100 px-2 py-0.5 text-red-800">Block</span>
                      </div>
                    )}
                  </div>
                  {index < STEPS.length - 1 && (
                    <ArrowRight
                      aria-hidden
                      className="absolute -right-3 top-1/2 z-10 hidden h-5 w-5 -translate-y-1/2 rounded-full bg-slate-50 text-slate-400 lg:block"
                    />
                  )}
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Why it matters */}
        <section aria-labelledby="why-title" className="px-4 py-20 sm:px-6">
          <div className="mx-auto max-w-5xl">
            <SectionHeading id="why-title" eyebrow="Why it matters" title="Built so tampering can’t hide" />
            <div className="mt-12 grid gap-5 md:grid-cols-2">
              {FEATURES.map(({ icon: FeatureIcon, title, body }) => (
                <article key={title} className="rounded-2xl border border-slate-200 bg-white p-7 shadow-sm transition hover:shadow-md">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-teal-50 text-teal-700">
                    <FeatureIcon aria-hidden className="h-6 w-6" />
                  </span>
                  <h3 className="mt-4 text-lg font-semibold">{title}</h3>
                  <p className="mt-2 leading-relaxed text-slate-600">{body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200 bg-gradient-to-b from-white to-teal-50/50 px-4 py-12 sm:px-6">
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-6 text-center sm:flex-row sm:justify-between sm:text-left">
          <div>
            <p className="text-lg font-semibold tracking-tight">Anchor Rx</p>
            <p className="mt-1 text-sm text-slate-600">Built for VMEDITHON 3.0 — Code Syndicate</p>
            <p className="mt-1 text-xs text-slate-500">Hackathon prototype · synthetic data only · decision support, not clinical judgment</p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <PortalButton />
            <PharmacyButton />
            <AuditButton />
          </div>
        </div>
      </footer>
    </div>
  );
}
