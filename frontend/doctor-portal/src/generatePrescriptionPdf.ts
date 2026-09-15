/**
 * One-page, printable prescription record built client-side with jsPDF from
 * GET /api/prescriptions/:prescriptionId/versions/:versionNumber/document.
 *
 * Deliberately plain: built-in Helvetica, monochrome, no logo artwork — the bubble logo font stays on the landing hero.
 * This is clinical paperwork and must read as trustworthy.
 *
 * buildPrescriptionPdf(data) returns the jsPDF document (layout only, no side effects), so the layout can be rendered
 * and checked outside a browser; generatePrescriptionPdf(data) builds it and triggers the download.
 */

import { jsPDF } from 'jspdf';
import type { PrescriptionDocument } from './types';

const PAGE = { width: 210, height: 297, margin: 20 }; // A4 portrait, millimetres
const QR_SIZE_MM = 48; // ≈ 1.9 in — comfortably above the 1.5 in minimum for a printed code to scan reliably
const LABEL_WIDTH_MM = 36;

type Rgb = readonly [number, number, number];
const TEXT: Rgb = [17, 24, 39];
const MUTED: Rgb = [100, 116, 139];
const RULE: Rgb = [203, 213, 225];

const STATUS_NOTES: Partial<Record<PrescriptionDocument['status'], string>> = {
  amended: 'This version has been superseded by a newer version of the prescription.',
  dispensed: 'This prescription has already been dispensed.',
  revoked: 'This prescription has been revoked by the prescriber.',
};

export const prescriptionPdfFilename = (data: PrescriptionDocument) => `AnchorRx_${data.prescriptionId}_v${data.versionNumber}.pdf`;

/** First 12 and last 6 characters of the integrity root. */
export const truncateIntegrityRoot = (root: string) => (root.length > 21 ? `${root.slice(0, 12)}...${root.slice(-6)}` : root);

/**
 * "500.000" + "mg" → "500 mg"; "2.500" → "2.5". Trims trailing zeros from the exact stored string only — it is never
 * parsed as a float, so no rounding can change the value shown.
 */
export function formatDosage(value: string, unit: string): string {
  const trimmed = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
  return `${trimmed} ${unit}`;
}

/** "YYYY-MM-DD" → "12 Apr 1985", without any time-zone conversion (a date of birth has no time). */
export function formatDateOfBirth(dob: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  if (!match) return dob;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}

/** ISO UTC instant → "15 Sep 2026, 10:16 GMT+5:30" in the viewer's time zone. */
export function formatIssuedAt(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(iso));
}

export function buildPrescriptionPdf(data: PrescriptionDocument): jsPDF {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  doc.setProperties({
    title: `Anchor Rx prescription ${data.prescriptionId} v${data.versionNumber}`,
    subject: 'Digital prescription record',
    creator: 'Anchor Rx',
  });

  const left = PAGE.margin;
  const right = PAGE.width - PAGE.margin;
  const setColor = (rgb: Rgb) => doc.setTextColor(rgb[0], rgb[1], rgb[2]);
  const rule = (y: number) => {
    doc.setDrawColor(RULE[0], RULE[1], RULE[2]);
    doc.setLineWidth(0.3);
    doc.line(left, y, right, y);
  };

  /** A titled block of label/value rows; returns the y below it. */
  const block = (title: string, rows: Array<[string, string]>, x: number, top: number, width: number): number => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    setColor(MUTED);
    doc.text(title.toUpperCase(), x, top, { charSpace: 0.35 });
    doc.setDrawColor(RULE[0], RULE[1], RULE[2]);
    doc.setLineWidth(0.3);
    doc.line(x, top + 1.8, x + width, top + 1.8);

    let y = top + 8;
    for (const [label, value] of rows) {
      // Many medicines can outgrow one page: continue on a new page instead of printing over the footer.
      if (y > PAGE.height - PAGE.margin - 26) {
        doc.addPage();
        y = PAGE.margin + 6;
      }
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      setColor(MUTED);
      doc.text(label, x, y);

      doc.setFontSize(11);
      setColor(TEXT);
      const lines = doc.splitTextToSize(value, width - LABEL_WIDTH_MM) as string[];
      doc.text(lines, x + LABEL_WIDTH_MM, y);
      y += Math.max(1, lines.length) * 5.2 + 1.6;
    }
    return y + 3;
  };

  // ── Header ────────────────────────────────────────────────────────────────────────────────────────────────
  let y = PAGE.margin;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  setColor(TEXT);
  doc.text('ANCHOR RX — Digital Prescription Record', left, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  setColor(MUTED);
  doc.text(`${data.prescriptionId} · Version ${data.versionNumber}`, right, y, { align: 'right' });
  y += 3.5;
  rule(y);

  // ── Title ─────────────────────────────────────────────────────────────────────────────────────────────────
  y += 12;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  setColor(TEXT);
  doc.text('Prescription', left, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  setColor(MUTED);
  doc.text(`Issued ${formatIssuedAt(data.issuedAt)}`, left, y + 6);

  // ── Provider + Patient (left column) · QR (right column) ─────────────────────────────────────────────────
  const columnTop = y + 18;
  const qrX = right - QR_SIZE_MM;
  const leftColumnWidth = qrX - left - 10;

  let leftY = block('Prescribing Provider', [['Name', data.provider.name], ['License number', data.provider.licenseNumber]], left, columnTop, leftColumnWidth);
  leftY = block(
    'Patient',
    [
      ['Name', data.patient.name],
      ['Patient ID', data.patient.patientId],
      ['Date of birth', formatDateOfBirth(data.patient.dob)],
      ['Height', data.heightCm ? `${data.heightCm.replace(/\.0$/, '')} cm` : 'not recorded'],
      ['Weight', data.weightKg ? `${data.weightKg.replace(/\.?0+$/, '')} kg` : 'not recorded'],
    ],
    left,
    leftY + 2,
    leftColumnWidth,
  );

  doc.setDrawColor(RULE[0], RULE[1], RULE[2]);
  doc.setLineWidth(0.3);
  doc.rect(qrX - 2, columnTop - 2, QR_SIZE_MM + 4, QR_SIZE_MM + 4);
  doc.addImage(data.qrImage, 'PNG', qrX, columnTop, QR_SIZE_MM, QR_SIZE_MM);
  doc.setFontSize(8);
  setColor(MUTED);
  doc.text('Scan at the pharmacy to verify', qrX + QR_SIZE_MM / 2, columnTop + QR_SIZE_MM + 7, { align: 'center' });

  // ── Medication + Record details (full width) ─────────────────────────────────────────────────────────────
  const fullWidth = right - left;
  let bodyY = Math.max(leftY, columnTop + QR_SIZE_MM + 12) + 4;
  bodyY = block(
    'Medication',
    [
      // One row per medicine, in sequence (prescribed) order.
      ...data.medicines.map((m): [string, string] => [
        `Medicine ${m.sequenceNumber}`,
        `${m.drugName} (${m.drugClass}) — ${formatDosage(m.dosageValue, m.dosageUnit)}, ${m.frequency}, ${m.durationDays} ${m.durationDays === 1 ? 'day' : 'days'}, quantity ${m.quantityPrescribed}`,
      ]),
      ['Route', data.route],
    ],
    left,
    bodyY,
    fullWidth,
  );
  bodyY = block(
    'Record Details',
    [
      ['Prescription ID', data.prescriptionId],
      ['Version', `v${data.versionNumber}`],
      ['Status', data.status],
      ['Issued', formatIssuedAt(data.issuedAt)],
    ],
    left,
    bodyY + 2,
    fullWidth,
  );

  const statusNote = STATUS_NOTES[data.status];
  if (statusNote) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    setColor(TEXT);
    doc.text(statusNote, left, bodyY + 2);
  }

  // ── Footer ───────────────────────────────────────────────────────────────────────────────────────────────
  const footerTop = PAGE.height - PAGE.margin - 16;
  rule(footerTop);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  setColor(MUTED);
  const note = doc.splitTextToSize(
    'This is a cryptographically-anchored digital prescription. Any alteration to this record after issuance is detectable.',
    fullWidth,
  ) as string[];
  doc.text(note, left, footerTop + 5);
  doc.setFont('courier', 'normal');
  doc.setFontSize(8.5);
  doc.text(`Integrity root: ${truncateIntegrityRoot(data.integrityRoot)}`, left, footerTop + 5 + note.length * 4 + 1.5);

  return doc;
}

export function generatePrescriptionPdf(data: PrescriptionDocument): void {
  buildPrescriptionPdf(data).save(prescriptionPdfFilename(data));
}
