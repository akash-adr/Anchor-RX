# Anchor Rx — Pharmacy demo scan payloads

Generated from the `anchor_rx` database on 2026-09-14T16:27:53.881Z by `npm run demo:payloads`.

**How to use:** in the Pharmacy Portal, open manual entry, copy the ONE line inside a grey box, paste, scan.
Re-run `npm run seed:demo` before a rehearsal to restore every scenario (the IDs below stay the same).

## 1. verified

🟢 expected: verified — Clean, current (v2), untampered, active prescriber · [QR image](demo-qr/1-verified.png)

```
{"prescriptionId":"RX-DEMO-0001","versionNumber":2,"issuedAt":"2026-09-14T16:27:53.696Z"}
```

## 2. tampered

🔴 expected: tampered — Dose changed 500 → 5000 mg directly in the database · [QR image](demo-qr/2-tampered.png)

```
{"prescriptionId":"RX-DEMO-0005","versionNumber":1,"issuedAt":"2026-09-14T16:27:53.705Z"}
```

## 3. forged

🔴 expected: forged — Ledger entry's anchored root rewritten; prescription row untouched · [QR image](demo-qr/3-forged.png)

```
{"prescriptionId":"RX-DEMO-0009","versionNumber":1,"issuedAt":"2026-09-14T16:27:53.727Z"}
```

## 4. stale_version

🔵 expected: stale_version (calm — newer version exists) — Version 1 QR after a legitimate amendment to v2 · [QR image](demo-qr/4-stale-version.png)

```
{"prescriptionId":"RX-DEMO-0006","versionNumber":1,"issuedAt":"2026-09-14T16:27:53.709Z"}
```

## 5. provider_identity_issue

🔴 expected: provider_identity_issue — Clean prescription, but prescriber PRV-004 is flagged · [QR image](demo-qr/5-provider-identity-issue.png)

```
{"prescriptionId":"RX-DEMO-0007","versionNumber":1,"issuedAt":"2026-09-14T16:27:53.720Z"}
```

## 6. revoked

🔴 expected: revoked — Revoked by the prescriber — must never be dispensed · [QR image](demo-qr/6-revoked.png)

```
{"prescriptionId":"RX-DEMO-0008","versionNumber":1,"issuedAt":"2026-09-14T16:27:53.723Z"}
```

## 7. unknown_prescription

🟠 expected: unknown_prescription — Well-formed QR for a prescription that does not exist · [QR image](demo-qr/7-unknown-prescription.png)

```
{"prescriptionId":"RX-DEMO-9999","versionNumber":1,"issuedAt":"2026-09-15T09:00:00.000Z"}
```

## 8. malformed_qr

🟠 expected: malformed_qr — Garbage that is not an Anchor Rx QR at all

```
ANCHOR-RX::this-is-not-a-real-qr-code
```

---

Notes

- Scanning logs a `verification_event` row; that is expected during rehearsal.
- `RX-DEMO-0006` **version 2** is the current version and scans as `verified` (useful right after the stale demo).
- The forged example keeps the ledger chain consistent, so prescriptions created live during the demo still verify.
