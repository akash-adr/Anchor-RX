"""Shared synthetic ScoringPayload builders for tests (not real patient data)."""

GP_HISTORY = {
    "analgesic": 30, "penicillin antibiotic": 25, "statin": 18, "nsaid": 15, "biguanide": 12,
    "calcium channel blocker": 12, "cephalosporin": 10, "macrolide antibiotic": 10, "leukotriene receptor antagonist": 6,
}


def make_payload(**overrides):
    """Atorvastatin 20 mg once daily for 30 days, 58-year-old, GP with a broad history — ordinary in every respect."""
    base = {
        "payloadVersion": 1, "prescriptionId": "RX-TEST-0001", "versionNumber": 1, "patientId": "PAT-T",
        "providerId": "PRV-T", "referenceTime": "2026-09-15T10:00:00.000Z",
        "drugName": "Atorvastatin", "drugClass": "statin", "doseValue": "20.000", "doseUnit": "mg",
        "frequency": "once daily", "durationDays": 30, "route": "oral",
        "patientAge": 58, "patientWeight": 76.0, "patientWeightIsDefault": False,
        "drugCombinationFlag": False, "overlappingPrescriptionIds": [],
        "providerDrugClassHistory": GP_HISTORY, "patientVelocity": 1,
    }
    return {**base, **overrides}


def extreme_payload():
    """50 g IV amoxicillin every 15 minutes for a year, duplicated class, from a cardiologist — breaks everything."""
    return make_payload(
        drugName="Amoxicillin", drugClass="penicillin antibiotic", doseValue="50000.000", frequency="every 15 minutes",
        durationDays=365, route="iv", patientAge=19, patientWeight=45.0, drugCombinationFlag=True,
        overlappingPrescriptionIds=["RX-X"], providerDrugClassHistory={"statin": 60, "calcium channel blocker": 40},
        patientVelocity=6,
    )


def tenfold_paracetamol_payload():
    """Paracetamol 5000 mg (10× a common 500 mg strength) four times daily for 5 days; otherwise ordinary."""
    return make_payload(drugName="Paracetamol", drugClass="analgesic", doseValue="5000.000", frequency="four times daily", durationDays=5)


def ml_only_unusual_payload():
    """Montelukast 10 mg once daily for 30 days — inside every rule range — but a 90-year-old, 140 kg patient with
    6 recent prescriptions, from a prescriber who only writes statins and calcium channel blockers."""
    return make_payload(
        drugName="Montelukast", drugClass="leukotriene receptor antagonist", doseValue="10.000", frequency="once daily",
        durationDays=30, patientAge=90, patientWeight=140.0, patientVelocity=6,
        providerDrugClassHistory={"statin": 60, "calcium channel blocker": 40},
    )
