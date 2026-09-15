'use strict';

/**
 * Module 6, Step 1 — pure QR generation tests (no database).
 */

const { PNG } = require('pngjs');
const jsQR = require('jsqr');
const { generateQrPayload, generateQrImage, buildVersionQr, parseQrPayload, PAYLOAD_KEYS } = require('../qr/qrEngine');

/** Decodes a PNG data URL with a real QR reader and returns the embedded text. */
function decodeQrDataUrl(dataUrl) {
  const png = PNG.sync.read(Buffer.from(dataUrl.split(',')[1], 'base64'));
  const code = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  if (!code) throw new Error('QR code could not be decoded');
  return code.data;
}

const ISSUED_AT = '2026-09-14T11:26:14.632Z';

describe('generateQrPayload', () => {
  test('returns exactly prescriptionId, versionNumber, issuedAt — nothing else', () => {
    const payload = generateQrPayload('RX-DEMO-0001', 2, ISSUED_AT);

    expect(Object.keys(payload).sort()).toEqual(['issuedAt', 'prescriptionId', 'versionNumber']);
    expect(payload).toEqual({ prescriptionId: 'RX-DEMO-0001', versionNumber: 2, issuedAt: ISSUED_AT });
    expect(PAYLOAD_KEYS).toEqual(['prescriptionId', 'versionNumber', 'issuedAt']);
  });

  test('never leaks clinical or identity fields into the payload', () => {
    const payload = generateQrPayload('RX-DEMO-0001', 1, ISSUED_AT);
    for (const forbidden of ['drugName', 'drug_name', 'dosage', 'dosageValue', 'dosage_value', 'dosageUnit', 'patientId', 'patient_id', 'providerId', 'frequency', 'durationDays', 'drugClass']) {
      expect(payload).not.toHaveProperty(forbidden);
    }
    const encoded = JSON.stringify(payload);
    expect(encoded).not.toMatch(/drug|dosage|patient|frequency|duration|provider/i);
  });

  test('normalizes a Date and an equivalent string to the same ISO issuedAt (reproducible QR)', () => {
    const fromDate = generateQrPayload('RX-DEMO-0001', 1, new Date(ISSUED_AT));
    const fromString = generateQrPayload('RX-DEMO-0001', 1, ISSUED_AT);
    expect(fromDate).toEqual(fromString);
    expect(JSON.stringify(fromDate)).toBe(JSON.stringify(fromString));
  });

  test.each([
    ['lowercase / malformed prescriptionId', ['rx-demo-0001', 1, ISSUED_AT]],
    ['non-integer version', ['RX-DEMO-0001', 1.5, ISSUED_AT]],
    ['version 0', ['RX-DEMO-0001', 0, ISSUED_AT]],
    ['invalid date', ['RX-DEMO-0001', 1, 'not-a-date']],
    ['missing issuedAt', ['RX-DEMO-0001', 1, undefined]],
  ])('rejects %s', (_label, args) => {
    expect(() => generateQrPayload(...args)).toThrow(TypeError);
  });
});

describe('generateQrImage', () => {
  test('produces a PNG data URL', async () => {
    const dataUrl = await generateQrImage(generateQrPayload('RX-DEMO-0001', 2, ISSUED_AT));

    expect(typeof dataUrl).toBe('string');
    expect(dataUrl.startsWith('data:image/')).toBe(true);
    expect(dataUrl).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
    // Decodes to a real PNG (magic bytes 89 50 4E 47).
    const png = Buffer.from(dataUrl.split(',')[1], 'base64');
    expect(png.subarray(0, 4).toString('hex')).toBe('89504e47');
  });

  test('is deterministic for the same payload', async () => {
    const payload = generateQrPayload('RX-DEMO-0001', 2, ISSUED_AT);
    expect(await generateQrImage(payload)).toBe(await generateQrImage({ ...payload }));
  });

  test('differs when the version differs', async () => {
    const v1 = await generateQrImage(generateQrPayload('RX-DEMO-0001', 1, ISSUED_AT));
    const v2 = await generateQrImage(generateQrPayload('RX-DEMO-0001', 2, ISSUED_AT));
    expect(v1).not.toBe(v2);
  });

  test('refuses a payload carrying extra (clinical) fields', async () => {
    const leaky = { ...generateQrPayload('RX-DEMO-0001', 1, ISSUED_AT), drugName: 'Amoxicillin', dosageValue: '500.000' };
    await expect(generateQrImage(leaky)).rejects.toThrow(/exactly prescriptionId, versionNumber, issuedAt/);
  });

  test('round-trips: a QR reader decodes the image back to exactly the payload JSON', async () => {
    const payload = generateQrPayload('RX-DEMO-0001', 2, ISSUED_AT);
    const decoded = decodeQrDataUrl(await generateQrImage(payload));

    expect(decoded).toBe(JSON.stringify(payload));
    expect(JSON.parse(decoded)).toEqual(payload);
  });

  test('refuses a payload missing a field', async () => {
    const { issuedAt, ...partial } = generateQrPayload('RX-DEMO-0001', 1, ISSUED_AT);
    await expect(generateQrImage(partial)).rejects.toThrow(TypeError);
  });
});

describe('buildVersionQr', () => {
  const ROW = Object.freeze({
    id: 7,
    prescription_id: 'RX-DEMO-0004',
    version_number: 3,
    patient_id: 'PAT-003',
    drug_name: 'Metformin',
    dosage_value: '750.000',
    dosage_unit: 'mg',
    created_at: new Date('2026-09-14T12:03:03.704Z'),
    amended_at: new Date('2026-09-14T12:09:00.000Z'), // set later, when superseded — must NOT be used
  });

  test('uses prescription_id, version_number and created_at only; clinical columns never reach the QR', async () => {
    const { qrPayload, qrImage } = await buildVersionQr(ROW);

    expect(qrPayload).toEqual({ prescriptionId: 'RX-DEMO-0004', versionNumber: 3, issuedAt: '2026-09-14T12:03:03.704Z' });
    const decoded = decodeQrDataUrl(qrImage);
    expect(JSON.parse(decoded)).toEqual(qrPayload);
    expect(decoded).not.toMatch(/Metformin|750|PAT-003|mg/);
  });

  test('is reproducible after the version is superseded (amended_at changing does not change the QR)', async () => {
    const before = await buildVersionQr({ ...ROW, amended_at: null });
    const after = await buildVersionQr(ROW);
    expect(after.qrImage).toBe(before.qrImage);
  });
});

describe('parseQrPayload', () => {
  const VALID = { prescriptionId: 'RX-DEMO-0001', versionNumber: 2, issuedAt: ISSUED_AT };
  const MALFORMED = { valid: false, error: 'malformed_qr' };
  const raw = (obj) => JSON.stringify(obj);

  test('valid payload passes and returns a fresh three-key payload', () => {
    const result = parseQrPayload(raw(VALID));
    expect(result).toEqual({ valid: true, payload: VALID });
    expect(Object.keys(result.payload).sort()).toEqual(['issuedAt', 'prescriptionId', 'versionNumber']);
  });

  test('invalid JSON returns malformed_qr without throwing', () => {
    for (const garbage of ['{not json', '', 'RX-DEMO-0001', '{"prescriptionId": "RX-DEMO-0001",', 'undefined', '﻿' + raw(VALID)]) {
      expect(() => parseQrPayload(garbage)).not.toThrow();
      expect(parseQrPayload(garbage)).toEqual(MALFORMED);
    }
  });

  test.each(['prescriptionId', 'versionNumber', 'issuedAt'])('valid JSON missing %s returns malformed_qr', (field) => {
    const { [field]: _omitted, ...partial } = VALID;
    expect(parseQrPayload(raw(partial))).toEqual(MALFORMED);
  });

  test('versionNumber as a string (not a number) returns malformed_qr', () => {
    expect(parseQrPayload(raw({ ...VALID, versionNumber: '2' }))).toEqual(MALFORMED);
  });

  test.each([
    ['boolean versionNumber', { ...VALID, versionNumber: true }],
    ['fractional versionNumber', { ...VALID, versionNumber: 1.5 }],
    ['versionNumber 0', { ...VALID, versionNumber: 0 }],
    ['negative versionNumber', { ...VALID, versionNumber: -3 }],
    ['unsafe integer versionNumber', { ...VALID, versionNumber: 2 ** 60 }],
    ['empty prescriptionId', { ...VALID, prescriptionId: '' }],
    ['non-string prescriptionId', { ...VALID, prescriptionId: 1234 }],
    ['badly formed prescriptionId', { ...VALID, prescriptionId: "rx-demo-0001'; DROP TABLE" }],
    ['issuedAt not a date', { ...VALID, issuedAt: 'not-a-date' }],
    ['issuedAt loose date string', { ...VALID, issuedAt: 'Sep 14 2026' }],
    ['issuedAt as epoch number', { ...VALID, issuedAt: 1789390774632 }],
    ['issuedAt impossible calendar date', { ...VALID, issuedAt: '2026-02-30T10:00:00.000Z' }],
    ['issuedAt without milliseconds/Z', { ...VALID, issuedAt: '2026-09-14T11:26:14' }],
    ['extra clinical field', { ...VALID, drugName: 'Amoxicillin' }],
  ])('%s returns malformed_qr', (_label, obj) => {
    expect(parseQrPayload(raw(obj))).toEqual(MALFORMED);
  });

  test('a __proto__ key is treated as an extra key, not silently accepted', () => {
    const sneaky = '{"prescriptionId":"RX-DEMO-0001","versionNumber":2,"issuedAt":"' + ISSUED_AT + '","__proto__":{"admin":true}}';
    expect(parseQrPayload(sneaky)).toEqual(MALFORMED);
    expect({}.admin).toBeUndefined();
  });

  test('non-object JSON and non-string inputs return malformed_qr without throwing', () => {
    const inputs = ['null', '[]', '42', '"RX-DEMO-0001"', 'true', null, undefined, 42, {}, [], Buffer.from(raw(VALID)), 'x'.repeat(5000)];
    for (const input of inputs) {
      expect(() => parseQrPayload(input)).not.toThrow();
      expect(parseQrPayload(input)).toEqual(MALFORMED);
    }
  });

  test('a well-formed but non-existent prescriptionId is still valid here (lookup decides "unknown")', () => {
    expect(parseQrPayload(raw({ ...VALID, prescriptionId: 'RX-NOPE-0001' })).valid).toBe(true);
  });

  test('round-trips with the generator: decode a real QR image, then parse', async () => {
    const payload = generateQrPayload('RX-DEMO-0004', 3, new Date(ISSUED_AT));
    const scanned = decodeQrDataUrl(await generateQrImage(payload));
    expect(parseQrPayload(scanned)).toEqual({ valid: true, payload });
  });

  test('tolerates scanner whitespace around valid JSON', () => {
    expect(parseQrPayload(`  ${raw(VALID)}\n`)).toEqual({ valid: true, payload: VALID });
  });
});
