# Anchor Rx — Doctor Portal

React + TypeScript + Vite + Tailwind frontend for prescribers. It is a thin client over the Anchor Rx API
(`backend/api`): it collects input, calls the API, and displays exactly what the API decided.

## Run

All THREE processes must be running — the AI risk engine is required for "Authorize & anchor":

```bash
npm run api            # from the repo root — Node API on http://localhost:4000 (DB: anchor_rx)
npm run doctor-portal  # from the repo root — portal on http://localhost:5173
cd ai-service && .venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000   # AI risk engine (FastAPI) on port 8000
```

**How they connect.** "Authorize & anchor" → `POST /api/prescriptions/assess-risk` (Node) → Node calls the AI risk
engine's `POST /score` once per medicine, concurrently (`RISK_ENGINE_URL`, default `http://127.0.0.1:8000`; timeout
`AI_SERVICE_TIMEOUT_MS`, default 3000 ms). "Confirm & Authorize" → `POST /api/prescriptions/confirm-and-create` with only
the assessment token — nothing is re-scored.

**If the AI engine is not running** (or times out), assess-risk still answers: each affected medicine is shown as
"AI risk assessment unavailable", the prescriber must still confirm, and that is locked on the prescription. Start the
engine before a demo so real scores appear.

**For the demo**, from `ai-service/` with the venv activated:

```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

`--host 0.0.0.0` listens on every network interface. Use it only when the Node API runs on a different machine than the
AI engine (then start the API with `RISK_ENGINE_URL=http://<ai-engine-host>:8000`). The engine has no authentication, so
on a single machine prefer `--host 127.0.0.1`.

The Vite dev server proxies `/api` to port 4000. Set `VITE_API_BASE_URL` to call another API host directly.
All HTTP calls live in [`src/api.ts`](src/api.ts); components never call `fetch` themselves.

> ⚠ **Mock login.** "Select your provider profile" is a hackathon-only stand-in with **no authentication**.
> The API trusts the `providerId` / `requestingProviderId` the client sends. Real JWT + RBAC is Module 11.

## Screens → endpoints

| Screen | User action | Endpoint | Component |
|---|---|---|---|
| Provider selection | Page load | `GET /api/providers` | `ProviderLogin.tsx` |
| New prescription | Page load (patient picker) | `GET /api/patients` | `CreatePrescription.tsx` |
| New prescription | **Authorize & anchor** | `POST /api/prescriptions` (response includes `qrPayload` + `qrImage`) | `CreatePrescription.tsx` |
| Amend | **Look up** | `GET /api/prescriptions/:id/provenance` (latest version = current state) | `AmendPrescription.tsx` |
| Amend | **Submit amendment** | `POST /api/prescriptions/:id/amend` (response includes the new version's `qrPayload` + `qrImage`) → then re-fetches provenance | `AmendPrescription.tsx` |
| Amend → Revoke | **Confirm revocation** (modal) | `POST /api/prescriptions/:id/revoke` → then re-fetches provenance | `RevokeDialog.tsx` |
| Pharmacy sign-in | Page load | `GET /api/pharmacies` | `pharmacy/PharmacyLogin.tsx` |
| Pharmacy scan | Camera decode or **Verify payload** | `POST /api/scan` (+ `GET /api/prescriptions/:id/provenance` and `GET /api/patients` for card details) | `pharmacy/PharmacyScanScreen.tsx` |
| History | **Show history** | `GET /api/prescriptions/:id/provenance`, plus `GET /api/providers` for display names | `HistoryView.tsx` |

## Landing page hero

The hero is typeset text — no video. The **Anchor Rx** wordmark is Space Grotesk 700 with a teal → dark-navy gradient
(`background-clip: text`), falling back to solid deep teal-navy (`#0f4c5c`) in browsers without `background-clip: text`
support. The tagline is Inter Light. Both fade in with a small upward slide (wordmark first, tagline 100 ms later);
the animation is disabled under `prefers-reduced-motion`. Styles live in `src/landing/landing.css`; fonts are loaded
from Google Fonts in `index.html`.

**Scope:** Space Grotesk and Inter are used by the landing page only. The Doctor, Pharmacy and Audit portals keep the
system UI font stack (`--font-sans` in `src/index.css`), unchanged.

The former animated logo files (`anchor-rx-logo-transparent.webm`, `anchor-rx-logo-alpha.mov`,
`anchor-rx-logo-poster.png`) are still in `public/` but are no longer referenced.

## QR codes

The QR shown after creating or amending comes from the API as a PNG data URL (`qrImage`) together with
the exact JSON it encodes (`qrPayload`): `{ prescriptionId, versionNumber, issuedAt }` — a pointer only,
never clinical data. Nothing is stored; the API regenerates it from the version's ID, number and
`created_at`, so the same version always yields the same QR. If generation ever fails, the version is still
saved and anchored and the portal shows "QR code unavailable".

## Pharmacy Portal: scan result → visual treatment

The Pharmacy Portal (`/pharmacy/scan`) sends every scan — camera or manual paste — through one `submitScan` →
`POST /api/scan`, and renders one card per `scanResult` (`src/pharmacy/results/ScanResultCards.tsx`).
**Visual urgency must match real urgency.** If you change any card's colour, icon, weight or wording, check it
against this table and update the table in the same change — do not harmonize the cards into one template.

| `scanResult` | Severity | Colour / frame | Icon | Card title | Tone and content rules |
|---|---|---|---|---|---|
| `verified` | Low — clear | Green (`emerald`) | CircleCheck | Prescription verified | Calm, minimal friction; short summary (drug, dose, frequency, duration, patient, prescriber) |
| `stale_version` | Informational | Blue (`sky`), no ring | Info | Updated to version N | Explicitly NOT alarming; shows current version marked "not yet verified by this scan", what changed, and a **Verify version N** action |
| `tampered` | Urgent | Red + ring | ShieldAlert | Prescription data was altered | Names each altered field in plain language ("Dosage was altered after issuance."); no clinical data shown |
| `forged` | Urgent | Red + ring | Link2Off | Verification record doesn't match issuance history | About the anchored record / ledger chain — never "a field was changed"; ledger ✓/✗ rows |
| `revoked` | Urgent | Red + ring | Ban | Prescription revoked by the prescriber | Withdrawn deliberately; shows revocation reason, who and when |
| `provider_identity_issue` | Identity concern | Orange + ring | UserX | The prescribing provider's status is currently {status} | About WHO prescribed, not what; notes field/ledger checks were not run |
| `unknown_prescription` | Suspicious, neutral | Grey, filled (`slate-100`) | CircleHelp | No such prescription exists | Never issued; possibly fabricated — distinct from a real prescription failing a check |
| `malformed_qr` | Technical | Light grey / white | ScanLine | This isn't a readable Anchor Rx QR code | Reading error; invites a rescan; no security language |

Not scan results — rendered separately and must stay visually distinct from every card above:

| State | Treatment | Rule |
|---|---|---|
| Request failed (network, timeout, 5xx, unreadable response) | Dark slate panel "Unable to reach verification service" + Retry | Says **"This prescription was NOT checked"** — never styled like a result |
| Unknown pharmacy (400 `UNKNOWN_PHARMACY`) | Same dark panel, pharmacy variant + Switch pharmacy | Setup problem, not a scan outcome |
| AI risk (Module 15) | One quiet line inside each card that resolved a version: `AI Risk: N%` (or "not recorded"), small muted text | The highest risk score LOCKED when the prescriber confirmed — never recalculated at scan time. No band, colour, icon or reasons; never gates dispensing. No Dispense / Review / Block wording may be derived from `scanResult` in the frontend (Module 9) |

Cards state findings and next steps only; none of them says "dispense" or "do not dispense".
The session "Scan history" list (plain React state, lost on reload) uses the same colour families as small dots and
logs failed requests as "not checked"; the authoritative audit trail is `verification_event` (Module 10).

## Client-side convenience vs. backend enforcement

**Rule for anyone changing this code:** nothing in this frontend is a security or authorization control.
Every check below exists only to save the user a pointless round trip or to explain the screen. If a
client-side check is wrong, stale, or bypassed (e.g. with `curl`), the backend must still make the right
decision — and the portal must still show the backend's `reason` verbatim.

### Client-side convenience only (NOT enforcement)

| Where | What the UI does | Why it is not the real rule |
|---|---|---|
| Amend form | `patientId`, `drugName`, `drugClass` rendered as disabled inputs; only dose/unit/frequency/duration are editable | Cosmetic. The API rejects any other field with `INVALID_AMENDMENT_FIELD` (Module 3). |
| Amend form + Revoke button | Whole form / Revoke button disabled when the loaded latest version is `dispensed` or `revoked` | Based on a snapshot that can be stale. Submitting from a stale page still reaches the API, which answers `NOT_AMENDABLE_STATUS` (verified in testing). |
| Amend form | Sends only fields that differ from the loaded version | Convenience. An empty or identical change is still sent; the API answers `NO_CHANGES`. |
| Revoke modal | Confirm disabled until the reason is non-blank | Convenience. The API independently requires a reason (`REASON_REQUIRED`). |
| New prescription form | Required fields, dose = positive number with ≤ 3 decimals, duration = whole days ≥ 1 | Early feedback only. The repository validates again (`INVALID_FIELD`, `MISSING_FIELD`, `UNKNOWN_REFERENCE`, …). The Amend form has **no** client validation on purpose — every rejection there is the server's. |
| Provider selection | Only lists active providers | Display only (the API filters). No authentication happens anywhere in the client. |
| Doses | `dosageValue` is kept as the exact string (`"500.000"`), never parsed to a number | Not a check — a correctness rule so float drift can never look like tampering to the hash engine. |

The frontend performs **no** authorization: it never checks whether the selected provider is the
original prescriber or a delegate. Any provider gets an enabled Amend form and Revoke button.

### Backend-enforced (the only authority)

Decided by Module 3 (`backend/versioning/authorization.js`, `amendmentService.js`) and the Module 1 repository,
and logged to `amendment_attempts` whether allowed or rejected:

| Decision | Reason code shown in the UI |
|---|---|
| Requesting provider is neither the original prescriber nor a delegate granted by them (`canAmend`) | `NOT_AUTHORIZED_PROVIDER` |
| Latest version is dispensed or revoked (`canAmend`, re-checked under a row lock in the repository) | `NOT_AMENDABLE_STATUS` |
| Prescription does not exist | `PRESCRIPTION_NOT_FOUND` |
| Amendment touches anything other than dose/unit/frequency/duration (`amendPrescriptionAuthorized`) | `INVALID_AMENDMENT_FIELD` |
| Empty amendment, or values identical to the current version | `NO_CHANGES` |
| Revocation without a reason (`revokePrescription`) | `REASON_REQUIRED` |
| Invalid values (e.g. dose `5e3`, 126-character drug name) | `INVALID_FIELD`, `MISSING_FIELD`, `UNKNOWN_REFERENCE` |
| Hashing, versioning, and ledger anchoring of every accepted change | (not user-facing; see Modules 2–4) |

## Loading and error states

Every API call shows a loading state and, on failure, a red notice with the **exact** `reason` code, the
API's message, and the HTTP status (`ErrorNotice.tsx`) — never a generic "something went wrong".

| Call | Loading state | Failure state |
|---|---|---|
| Providers | Skeleton cards | Notice + **Try again** |
| Patients (create) | Skeleton field | Notice + **Retry loading patients** (submit stays disabled until loaded) |
| Create | Spinner + "Authorizing & anchoring…", inputs disabled | Notice above the button; form values kept |
| Amend lookup | "Looking up…" | Notice |
| Amend submit | Spinner + "Submitting…", fieldset disabled | Notice above the buttons |
| Revoke | Spinner + "Revoking…" inside the modal | Notice inside the modal (modal stays open) |
| History lookup | "Loading…" | Notice |
| History provider names | — | Amber note "showing provider IDs only" |

Failure reasons produced by the client itself (`src/api.ts`):

| Reason | When |
|---|---|
| `API_UNREACHABLE` | Network failure, or the dev proxy answers 502/503/504 because the API is not running |
| `TIMEOUT` | No response within 15 seconds |
| `HTTP_<status>` | Non-2xx response without an Anchor Rx error body |
| `INVALID_RESPONSE` | 2xx response whose body is not readable JSON |
| `RENDER_ERROR` | A screen threw while rendering (`ErrorBoundary.tsx`), instead of a blank page |

## Audit Dashboard (Module 10)

Open it from the landing page with **Enter Audit Dashboard**.

> ⚠ **Prototype: zero access control.** The landing link is the entire "gate": there is no auditor identity, login or session, and the `/api/audit/*` endpoints have no auth. It is even more minimal than the Doctor/Pharmacy mock logins.

| Route | Screen | API |
|---|---|---|
| `/audit` | Summary list — the auditor's starting point. Rows whose **live** integrity recheck fails are flagged red; scan and trust-decision columns are history. | `GET /api/audit/summary?currentStatus=&onlyConcerning=` |
| `/audit/prescriptions/:id` | **Current Integrity Status** card (top) with *Recheck now*, then the **History** timeline. | `GET …/recheck` (on demand), `GET …/timeline` |

Screen rules:
- The live recheck card and the History timeline are separate components with separate requests and state. Never merge a recheck result into the timeline — history says what was recorded *then*, the card says what is true *now*.
- A pharmacy scan's trust decision is nested inside its scan card (linked by `verification_event_id`), not shown as its own entry.
- Times show milliseconds (audit events can be milliseconds apart); hover for the exact UTC value.
- Scan-result chips reuse the pharmacy severity colours above.

## Known gaps (Module 16)

- **Amendments are not risk-scored.** The preview → confirm → lock flow (Module 15) covers *creating* a prescription
  only. The Amend screen submits directly, so an amended version gets no AI risk preview and its medicines have no
  locked risk (`locked_risk_*` is NULL; the Pharmacy Portal shows "AI Risk: not recorded" for it). Consequently
  `liveDataBridge.buildFeatureInputs`' `existingPrescriptionVersionId` has no caller yet. Decided in Module 16 Step 2:
  documented, not built.
- **Live rarity scores are held.** `buildFeatureInputs` computes `drug_rarity_score` and `provider_rarity_score` from
  real prescription data, but they are not sent to the AI service yet — see `ai-service/NOTES.md`
  ("Live data bridge: what is and isn't live yet").
