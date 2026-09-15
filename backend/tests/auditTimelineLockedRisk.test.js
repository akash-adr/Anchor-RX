'use strict';

/**
 * Module 15 Step 5 — getMergedTimeline surfaces the risk the prescriber CONFIRMED, read from locked_risk_* only.
 *
 * Every Node scoring entry point is replaced by a "retrained model" that now answers 90 for everything. The locked
 * value is 65. If the timeline ever recomputed risk, it would show 90 (and the call counter would move).
 */

const mockScoringCalls = [];
const mockRetrainedResult = () => ({
  riskScore: 90,
  riskBand: 'high',
  reasons: [{ source: 'ml_model', feature: 'dose_value', explanation: 'Retrained model output (simulated).' }],
  details: null,
});

jest.mock('../ml/scoreClient', () => {
  const actual = jest.requireActual('../ml/scoreClient');
  return {
    ...actual,
    createScoreClient: () => ({
      scorePrescriptionViaAI: async () => {
        mockScoringCalls.push('scorePrescriptionViaAI');
        return mockRetrainedResult();
      },
      scorePayloadViaAI: async () => {
        mockScoringCalls.push('scorePayloadViaAI');
        return mockRetrainedResult();
      },
    }),
  };
});

jest.mock('../ml/scoreAllMedicines', () => ({
  createMedicineScorer: () => ({
    buildSharedContext: async () => ({}),
    scoreAllMedicines: async (medicines) => {
      mockScoringCalls.push('scoreAllMedicines');
      return medicines.map((m, medicineIndex) => {
        const { riskScore, riskBand, reasons } = mockRetrainedResult();
        return { medicineIndex, drugName: m.drugName, riskScore, riskBand, reasons };
      });
    },
  }),
}));

const { createPool } = require('../db/connection');
const { seed } = require('../db/seed/seed');
const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
const { createAmendmentService } = require('../versioning/amendmentService');
const { createAuditTimeline, EVENT_TYPES } = require('../audit/timeline');
const { createScoreClient } = require('../ml/scoreClient');
const { createMedicineScorer } = require('../ml/scoreAllMedicines');

const TEST_DB_NAME = process.env.TEST_DB_NAME || 'anchor_rx_test';
if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run destructive tests against non-test database "${TEST_DB_NAME}"`);
}

const CONFIRMED_REASONS = [{ source: 'rule_engine', feature: 'dose_value', explanation: 'Dose exceeds the typical maximum for this medication.' }];

let pool;
let repository;
let getMergedTimeline;

beforeAll(() => {
  pool = createPool({ database: TEST_DB_NAME });
  repository = createPrescriptionVersionRepository(pool);
  ({ getMergedTimeline } = createAuditTimeline(pool, { amendmentService: createAmendmentService(pool, { repository }) }));
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await seed(pool);
  mockScoringCalls.length = 0;
});

const medicine = (drugName, drugClass, dosageValue) => ({ drugName, drugClass, dosageValue, dosageUnit: 'mg', frequency: 'three times daily', durationDays: 5, quantityPrescribed: 15 });

test('locked 65 stays 65 on the timeline even though the (retrained) model now scores 90 — nothing is recomputed', async () => {
  const v1 = await repository.createPrescription(
    { patientId: 'PAT-001', providerId: 'PRV-001', medicines: [medicine('Paracetamol', 'analgesic', '1000'), medicine('Cetirizine', 'antihistamine', '10')] },
    { lockedRisks: [{ riskScore: 65, riskBand: 'review', reasons: CONFIRMED_REASONS }, { riskScore: 12, riskBand: 'low', reasons: [] }] },
  );

  // The "retrained model" really does answer 90 now, through every scoring path.
  expect((await createScoreClient(pool).scorePrescriptionViaAI(v1.prescription_id, 1)).riskScore).toBe(90);
  expect((await createMedicineScorer(pool).scoreAllMedicines([medicine('Paracetamol', 'analgesic', '1000')], {}))[0].riskScore).toBe(90);
  // …and even a direct attempt to overwrite the lock with the new number is refused by the database.
  await expect(
    pool.execute("UPDATE prescription_medicine SET locked_risk_score = 90, locked_risk_band = 'high' WHERE medicine_id = ?", [v1.medicines[0].medicine_id]),
  ).rejects.toMatchObject({ sqlState: '45000' });
  const callsBefore = mockScoringCalls.length;

  const { timeline } = await getMergedTimeline(v1.prescription_id);

  expect(mockScoringCalls.length).toBe(callsBefore); // getMergedTimeline made no scoring call of any kind
  const created = timeline.find((event) => event.eventType === EVENT_TYPES.VERSION_CREATED);
  expect(created.detail.medicines.map((m) => [m.sequenceNumber, m.drugName, m.lockedRisk])).toEqual([
    [1, 'Paracetamol', { riskScore: 65, riskBand: 'review', reasons: CONFIRMED_REASONS }],
    [2, 'Cetirizine', { riskScore: 12, riskBand: 'low', reasons: [] }],
  ]);
  expect(created.detail.medicines[0].lockedRisk.riskScore).not.toBe(90);
});

test('version_amended carries its own stored lock (null — amendments do not copy locked risk forward yet); created keeps 65', async () => {
  const v1 = await repository.createPrescription(
    { patientId: 'PAT-001', providerId: 'PRV-001', medicines: [medicine('Paracetamol', 'analgesic', '1000')] },
    { lockedRisks: [{ riskScore: 65, riskBand: 'review', reasons: CONFIRMED_REASONS }] },
  );
  await repository.amendPrescription(v1.prescription_id, { medicineId: v1.medicines[0].medicine_id, dosageValue: '500' }, 'PRV-001', 'Lower dose');

  const { timeline } = await getMergedTimeline(v1.prescription_id);

  const byType = (type) => timeline.filter((event) => event.eventType === type);
  expect(byType(EVENT_TYPES.VERSION_CREATED)[0].detail.medicines[0].lockedRisk).toEqual({ riskScore: 65, riskBand: 'review', reasons: CONFIRMED_REASONS });
  const amended = byType(EVENT_TYPES.VERSION_AMENDED)[0];
  expect(amended.detail.medicines).toEqual([expect.objectContaining({ sequenceNumber: 1, dosageValue: '500.000', lockedRisk: null })]);
  expect(mockScoringCalls).toEqual([]);
});

test('a prescription created before Module 15 (seeded) shows lockedRisk null — never a live score', async () => {
  const { timeline } = await getMergedTimeline('RX-DEMO-0003');
  expect(timeline.find((event) => event.eventType === EVENT_TYPES.VERSION_CREATED).detail.medicines.map((m) => m.lockedRisk)).toEqual([null]);
  expect(mockScoringCalls).toEqual([]);
});
