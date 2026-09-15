import { Scale } from 'lucide-react';

/**
 * EMPTY SLOT for Module 9 (trust decision = integrity result + AI risk score → Dispense / Review / Block).
 *
 * This box is deliberately IDENTICAL for every scan result. It must never show, colour-code or imply a
 * Dispense / Review / Block judgment derived from scanResult — doing so would quietly implement a shadow
 * version of Module 9's logic in the frontend. When Module 9 exists, it supplies the decision; this slot
 * only displays it.
 */
export default function TrustDecisionPlaceholder() {
  return (
    <section
      data-testid="trust-decision-placeholder"
      aria-label="Trust decision"
      className="flex items-start gap-3 rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 px-5 py-4"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-slate-400 ring-1 ring-slate-200">
        <Scale aria-hidden className="h-5 w-5" />
      </span>
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Trust engine</p>
        <p className="font-semibold text-slate-700">Pending integration</p>
        <p className="text-sm text-slate-500">
          The dispense decision will come from the trust engine (Module 9). No decision has been made here.
        </p>
      </div>
    </section>
  );
}
