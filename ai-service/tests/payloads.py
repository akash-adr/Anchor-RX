"""Shared synthetic ScoringPayload builders for tests (not real patient data). Drugs come from data/dosage_reference.py."""

GP_HISTORY = {
    "antibiotic": 30, "nsaid": 20, "statin": 18, "ppi": 15, "antidiabetic": 12, "ace_inhibitor": 10,
    "antihistamine": 10, "arb": 8, "ssri": 8, "anticoagulant": 4,
}


def make_payload(**overrides):
    """CLEAN demo case — Amoxicillin 500 mg three times daily for 7 days (inside every reference range), 58-year-old,
    GP with a broad history — ordinary in every respect."""
    base = {
        "payloadVersion": 1, "prescriptionId": "RX-TEST-0001", "versionNumber": 1, "patientId": "PAT-T",
        "providerId": "PRV-T", "referenceTime": "2026-09-15T10:00:00.000Z",
        "drugName": "Amoxicillin", "drugClass": "antibiotic", "doseValue": "500.000", "doseUnit": "mg",
        "frequency": "three times daily", "durationDays": 7, "route": "oral",
        "patientAge": 58, "patientWeight": 76.0, "patientWeightIsDefault": False,
        "drugCombinationFlag": False, "overlappingPrescriptionIds": [],
        "providerDrugClassHistory": GP_HISTORY, "patientVelocity": 1,
    }
    return {**base, **overrides}


def extreme_payload():
    """50 g IV amoxicillin every 15 minutes for a year, duplicated class, from a cardiologist — breaks everything."""
    return make_payload(
        doseValue="50000.000", frequency="every 15 minutes", durationDays=365, route="iv", patientAge=19,
        patientWeight=45.0, drugCombinationFlag=True, overlappingPrescriptionIds=["RX-X"],
        providerDrugClassHistory={"statin": 60, "arb": 40}, patientVelocity=6,
    )


def tenfold_roxithromycin_payload():
    """ALTERED-DOSE demo case — Roxithromycin 3000 mg (10x the 300 mg reference maximum) twice daily for 7 days;
    otherwise ordinary."""
    return make_payload(drugName="Roxithromycin", drugClass="antibiotic", doseValue="3000.000", frequency="twice daily", durationDays=7)


def ml_only_unusual_payload():
    """Escitalopram 10 mg once daily for 60 days — inside every rule range — but a 90-year-old, 140 kg patient with
    6 recent prescriptions, from a prescriber who only writes statins and ARBs."""
    return make_payload(
        drugName="Escitalopram", drugClass="ssri", doseValue="10.000", frequency="once daily", durationDays=60,
        patientAge=90, patientWeight=140.0, patientVelocity=6, providerDrugClassHistory={"statin": 60, "arb": 40},
    )
