"""
Synthetic dosage reference table for the Anchor Rx AI risk engine.

⚠ ILLUSTRATIVE SYNTHETIC DATA FOR A HACKATHON PROTOTYPE — NOT SOURCED FROM REAL CLINICAL REFERENCES.
The numbers below are plausible-looking ranges chosen to exercise the risk engine (feature distributions,
rule-engine limits, synthetic corpus generation). They are not dosing guidance, have not been clinically
reviewed, and must never be presented as real clinical limits. If asked: "synthetic, illustrative ranges".

Drug names match the Anchor Rx demo seed data so demo scoring is consistent.
All mass doses are in mg. Frequencies are doses per day (see features/extract.py parse_doses_per_day).
Adult dosing only — paediatric dosing is out of scope for the placeholder corpus.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class DrugReference:
    drug_name: str
    drug_class: str
    unit: str  # canonical unit for dose values ("mg")
    typical_dose_min: float  # per administration, in `unit`
    typical_dose_max: float
    max_single_dose: float  # synthetic "hard" ceiling used by the rule engine (Step 3)
    typical_dose_per_kg_max: float  # per administration, mg/kg
    typical_doses_per_day: tuple[float, ...]  # allowed/typical frequencies
    max_doses_per_day: float
    typical_duration_min_days: int
    typical_duration_max_days: int
    common_strengths: tuple[float, ...]  # commonly prescribed per-dose strengths, in `unit`
    chronic: bool  # long-term therapy (drives duration/age/velocity patterns in the synthetic corpus)
    routes: tuple[str, ...] = ("oral",)


def _ref(**kwargs) -> DrugReference:
    return DrugReference(unit="mg", **kwargs)


DOSAGE_REFERENCE: dict[str, DrugReference] = {
    ref.drug_name.lower(): ref
    for ref in (
        _ref(drug_name="Amoxicillin", drug_class="penicillin antibiotic", typical_dose_min=250, typical_dose_max=1000,
             max_single_dose=1000, typical_dose_per_kg_max=25, typical_doses_per_day=(2, 3), max_doses_per_day=3,
             typical_duration_min_days=5, typical_duration_max_days=14, common_strengths=(250, 500, 875, 1000),
             chronic=False, routes=("oral", "iv")),
        _ref(drug_name="Cefalexin", drug_class="cephalosporin", typical_dose_min=250, typical_dose_max=1000,
             max_single_dose=1000, typical_dose_per_kg_max=25, typical_doses_per_day=(2, 3, 4), max_doses_per_day=4,
             typical_duration_min_days=5, typical_duration_max_days=14, common_strengths=(250, 500, 1000),
             chronic=False),
        _ref(drug_name="Azithromycin", drug_class="macrolide antibiotic", typical_dose_min=250, typical_dose_max=500,
             max_single_dose=500, typical_dose_per_kg_max=10, typical_doses_per_day=(1,), max_doses_per_day=1,
             typical_duration_min_days=3, typical_duration_max_days=5, common_strengths=(250, 500),
             chronic=False, routes=("oral", "iv")),
        _ref(drug_name="Atorvastatin", drug_class="statin", typical_dose_min=10, typical_dose_max=80,
             max_single_dose=80, typical_dose_per_kg_max=1.2, typical_doses_per_day=(1,), max_doses_per_day=1,
             typical_duration_min_days=28, typical_duration_max_days=365, common_strengths=(10, 20, 40, 80),
             chronic=True),
        _ref(drug_name="Rosuvastatin", drug_class="statin", typical_dose_min=5, typical_dose_max=40,
             max_single_dose=40, typical_dose_per_kg_max=0.6, typical_doses_per_day=(1,), max_doses_per_day=1,
             typical_duration_min_days=28, typical_duration_max_days=365, common_strengths=(5, 10, 20, 40),
             chronic=True),
        _ref(drug_name="Metformin", drug_class="biguanide", typical_dose_min=500, typical_dose_max=1000,
             max_single_dose=1000, typical_dose_per_kg_max=15, typical_doses_per_day=(1, 2, 3), max_doses_per_day=3,
             typical_duration_min_days=30, typical_duration_max_days=365, common_strengths=(500, 850, 1000),
             chronic=True),
        _ref(drug_name="Amlodipine", drug_class="calcium channel blocker", typical_dose_min=2.5, typical_dose_max=10,
             max_single_dose=10, typical_dose_per_kg_max=0.15, typical_doses_per_day=(1,), max_doses_per_day=1,
             typical_duration_min_days=30, typical_duration_max_days=365, common_strengths=(2.5, 5, 10),
             chronic=True),
        _ref(drug_name="Paracetamol", drug_class="analgesic", typical_dose_min=325, typical_dose_max=1000,
             max_single_dose=1000, typical_dose_per_kg_max=15, typical_doses_per_day=(1, 2, 3, 4), max_doses_per_day=4,
             typical_duration_min_days=1, typical_duration_max_days=7, common_strengths=(325, 500, 650, 1000),
             chronic=False, routes=("oral", "iv")),
        _ref(drug_name="Ibuprofen", drug_class="nsaid", typical_dose_min=200, typical_dose_max=800,
             max_single_dose=800, typical_dose_per_kg_max=10, typical_doses_per_day=(1, 2, 3), max_doses_per_day=3,
             typical_duration_min_days=1, typical_duration_max_days=10, common_strengths=(200, 400, 600, 800),
             chronic=False),
        _ref(drug_name="Montelukast", drug_class="leukotriene receptor antagonist", typical_dose_min=10,
             typical_dose_max=10, max_single_dose=10, typical_dose_per_kg_max=0.2, typical_doses_per_day=(1,),
             max_doses_per_day=1, typical_duration_min_days=30, typical_duration_max_days=180,
             common_strengths=(10,), chronic=True),
    )
}


def get_reference(drug_name: str) -> DrugReference | None:
    """Case-insensitive lookup; None for drugs outside the synthetic table."""
    return DOSAGE_REFERENCE.get(drug_name.strip().lower())
