'use strict';

/**
 * Module 9 Step 2 — AI service HTTP client. No database: the payload builder is injected.
 * Uses stub fetch for exact contract checks, plus real sockets for connection-refused / HTTP 500 / timeout.
 */

const http = require('http');
const { createScoreClient, translateAIResponse, AIServiceError, DEFAULT_AI_SERVICE_URL, DEFAULT_TIMEOUT_MS } = require('../ml/scoreClient');
const { ScoringPayloadError } = require('../ml/buildScoringPayload');
const { decideTrust } = require('../trust/decideTrust');

const PAYLOAD = Object.freeze({ payloadVersion: 1, prescriptionId: 'RX-DEMO-0003', versionNumber: 1, drugName: 'Rosuvastatin' });

const PYTHON_RESPONSE = {
  risk_score: 25,
  risk_band: 'low',
  reasons: [{ source: 'rule_engine', feature: 'drug_combination_flag', explanation: 'Patient has another active prescription in the same drug class.' }],
  details: {
    ml_subscore: 18.57,
    rule_subscore: 25,
    rules_not_evaluated: [{ rule: 'dose_limit', reason: "dose unit 'ml' cannot be compared with a mg limit" }],
    patient_weight_is_default: false,
    model_version: 'isolation-forest-placeholder-v1',
  },
};

const builder = () => ({ buildScoringPayload: jest.fn(async () => PAYLOAD) });
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function allKeys(value, keys = []) {
  if (Array.isArray(value)) value.forEach((item) => allKeys(item, keys));
  else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      allKeys(child, keys);
    }
  }
  return keys;
}

async function expectAIServiceError(promise, reason, extra = {}) {
  const error = await promise.then(
    () => {
      throw new Error('expected AIServiceError');
    },
    (err) => err,
  );
  expect(error).toBeInstanceOf(AIServiceError);
  expect(error).toMatchObject({ name: 'AIServiceError', code: 'AI_SERVICE_UNAVAILABLE', reason, ...extra });
  return error;
}

// ── success path ────────────────────────────────────────────────────────────────────────────────────────────

test('POSTs the built payload to <AI_SERVICE_URL>/score and returns the camelCase contract', async () => {
  const payloadBuilder = builder();
  const fetchImpl = jest.fn(async () => jsonResponse(PYTHON_RESPONSE));
  const { scorePrescriptionViaAI } = createScoreClient(null, { payloadBuilder, fetchImpl, baseUrl: 'http://ai.internal:8123/' });

  const result = await scorePrescriptionViaAI('RX-DEMO-0003', 1);

  expect(payloadBuilder.buildScoringPayload).toHaveBeenCalledWith('RX-DEMO-0003', 1);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [url, init] = fetchImpl.mock.calls[0];
  expect(url).toBe('http://ai.internal:8123/score');
  expect(init.method).toBe('POST');
  expect(init.headers['Content-Type']).toBe('application/json');
  expect(JSON.parse(init.body)).toEqual(PAYLOAD);
  expect(init.signal).toBeInstanceOf(AbortSignal);

  expect(result).toEqual({
    riskScore: 25,
    riskBand: 'low',
    reasons: [{ source: 'rule_engine', feature: 'drug_combination_flag', explanation: 'Patient has another active prescription in the same drug class.' }],
    details: {
      mlSubscore: 18.57,
      ruleSubscore: 25,
      rulesNotEvaluated: [{ rule: 'dose_limit', reason: "dose unit 'ml' cannot be compared with a mg limit" }],
      patientWeightIsDefault: false,
      modelVersion: 'isolation-forest-placeholder-v1',
    },
  });
  expect(allKeys(result).filter((key) => key.includes('_'))).toEqual([]); // no snake_case key leaks past the client
});

test('the translated result is exactly what decideTrust needs (not riskEngineUnavailable)', async () => {
  const { scorePrescriptionViaAI } = createScoreClient(null, { payloadBuilder: builder(), fetchImpl: async () => jsonResponse(PYTHON_RESPONSE) });
  const decision = decideTrust({ scanResult: 'verified', fieldVerification: null, ledgerVerification: null }, await scorePrescriptionViaAI('RX-DEMO-0003', 1));
  expect(decision).toMatchObject({ trustDecision: 'Dispense', primaryReason: 'clean', riskScore: 25, riskBand: 'low' });
});

test('base URL comes from AI_SERVICE_URL, defaulting to the Module 8 port', async () => {
  expect(DEFAULT_AI_SERVICE_URL).toBe('http://127.0.0.1:8000');
  const original = process.env.AI_SERVICE_URL;
  try {
    delete process.env.AI_SERVICE_URL;
    const defaultFetch = jest.fn(async () => jsonResponse(PYTHON_RESPONSE));
    await createScoreClient(null, { payloadBuilder: builder(), fetchImpl: defaultFetch }).scorePrescriptionViaAI('RX-DEMO-0003', 1);
    expect(defaultFetch.mock.calls[0][0]).toBe('http://127.0.0.1:8000/score');

    process.env.AI_SERVICE_URL = 'http://risk.example.test:9000';
    const envFetch = jest.fn(async () => jsonResponse(PYTHON_RESPONSE));
    await createScoreClient(null, { payloadBuilder: builder(), fetchImpl: envFetch }).scorePrescriptionViaAI('RX-DEMO-0003', 1);
    expect(envFetch.mock.calls[0][0]).toBe('http://risk.example.test:9000/score');
  } finally {
    if (original === undefined) delete process.env.AI_SERVICE_URL;
    else process.env.AI_SERVICE_URL = original;
  }
});

// ── failure modes (stubbed) ─────────────────────────────────────────────────────────────────────────────────

test('network failure → AIServiceError reason "network"', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  };
  const error = await expectAIServiceError(createScoreClient(null, { payloadBuilder: builder(), fetchImpl }).scorePrescriptionViaAI('RX-DEMO-0003', 1), 'network');
  expect(error.message).toContain('ECONNREFUSED');
});

test('no response within the timeout → AIServiceError reason "timeout"', async () => {
  const hangingFetch = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const client = createScoreClient(null, { payloadBuilder: builder(), fetchImpl: hangingFetch, timeoutMs: 25 });
  await expectAIServiceError(client.scorePrescriptionViaAI('RX-DEMO-0003', 1), 'timeout');
});

test.each([500, 503, 422, 404])('HTTP %i → AIServiceError reason "http_status" with the status', async (status) => {
  const fetchImpl = async () => jsonResponse({ detail: 'nope' }, status);
  const error = await expectAIServiceError(createScoreClient(null, { payloadBuilder: builder(), fetchImpl }).scorePrescriptionViaAI('RX-DEMO-0003', 1), 'http_status', { status });
  expect(error.responseBody).toContain('nope');
});

test('non-JSON 200 body → AIServiceError reason "invalid_response"', async () => {
  const fetchImpl = async () => new Response('<html>proxy error</html>', { status: 200 });
  await expectAIServiceError(createScoreClient(null, { payloadBuilder: builder(), fetchImpl }).scorePrescriptionViaAI('RX-DEMO-0003', 1), 'invalid_response');
});

test.each([
  ['already camelCase', { riskScore: 25, riskBand: 'low', reasons: [] }],
  ['unknown band', { ...PYTHON_RESPONSE, risk_band: 'medium' }],
  ['score above 100', { ...PYTHON_RESPONSE, risk_score: 101 }],
  ['non-integer score', { ...PYTHON_RESPONSE, risk_score: 25.5 }],
  ['score as string', { ...PYTHON_RESPONSE, risk_score: '25' }],
  ['reasons missing', { risk_score: 25, risk_band: 'low' }],
  ['too many reasons', { ...PYTHON_RESPONSE, reasons: Array(4).fill(PYTHON_RESPONSE.reasons[0]) }],
  ['unknown reason source', { ...PYTHON_RESPONSE, reasons: [{ source: 'gut_feeling', feature: 'x', explanation: 'y' }] }],
  ['array body', [PYTHON_RESPONSE]],
  ['null body', null],
])('shape drift (%s) → AIServiceError reason "invalid_response"', async (_label, body) => {
  const fetchImpl = async () => jsonResponse(body);
  await expectAIServiceError(createScoreClient(null, { payloadBuilder: builder(), fetchImpl }).scorePrescriptionViaAI('RX-DEMO-0003', 1), 'invalid_response');
});

test('payload-building errors are not AI outages: they propagate unchanged and nothing is sent', async () => {
  const payloadBuilder = { buildScoringPayload: jest.fn(async () => { throw new ScoringPayloadError('VERSION_NOT_FOUND', 'RX-NOPE v1 does not exist'); }) };
  const fetchImpl = jest.fn();
  const error = await createScoreClient(null, { payloadBuilder, fetchImpl }).scorePrescriptionViaAI('RX-NOPE', 1).catch((err) => err);
  expect(error).toBeInstanceOf(ScoringPayloadError);
  expect(error).not.toBeInstanceOf(AIServiceError);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('details are optional in the service response', () => {
  const { details, ...withoutDetails } = PYTHON_RESPONSE;
  expect(translateAIResponse(withoutDetails)).toEqual({ riskScore: 25, riskBand: 'low', reasons: PYTHON_RESPONSE.reasons, details: null });
});

// ── failure modes over real sockets (real global fetch) ─────────────────────────────────────────────────────

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('real connection refused → "network"', async () => {
  const server = await listen(() => {});
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve)); // port now closed
  const client = createScoreClient(null, { payloadBuilder: builder(), baseUrl: `http://127.0.0.1:${port}` });
  await expectAIServiceError(client.scorePrescriptionViaAI('RX-DEMO-0003', 1), 'network');
});

test('real HTTP 500 → "http_status"', async () => {
  const server = await listen((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  });
  try {
    const client = createScoreClient(null, { payloadBuilder: builder(), baseUrl: `http://127.0.0.1:${server.address().port}` });
    await expectAIServiceError(client.scorePrescriptionViaAI('RX-DEMO-0003', 1), 'http_status', { status: 500 });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('real server that never answers → "timeout"', async () => {
  const server = await listen(() => {}); // accepts the request, never responds
  try {
    const client = createScoreClient(null, { payloadBuilder: builder(), baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 150 });
    const started = Date.now();
    await expectAIServiceError(client.scorePrescriptionViaAI('RX-DEMO-0003', 1), 'timeout');
    expect(Date.now() - started).toBeLessThan(2000);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('RISK_ENGINE_URL takes precedence over the older AI_SERVICE_URL, and the default timeout is 3000 ms', async () => {
  expect(DEFAULT_TIMEOUT_MS).toBe(3000);
  const saved = { RISK_ENGINE_URL: process.env.RISK_ENGINE_URL, AI_SERVICE_URL: process.env.AI_SERVICE_URL };
  try {
    process.env.AI_SERVICE_URL = 'http://old-name.example.test:9000';
    process.env.RISK_ENGINE_URL = 'http://risk-engine.example.test:8000';
    const fetchImpl = jest.fn(async () => jsonResponse(PYTHON_RESPONSE));
    await createScoreClient(null, { payloadBuilder: builder(), fetchImpl }).scorePrescriptionViaAI('RX-DEMO-0003', 1);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://risk-engine.example.test:8000/score');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
