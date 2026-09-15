"""
The Node → Python scoring payload contract (ScoringPayload v1).

Mirrors backend/ml/buildScoringPayload.js exactly (camelCase JSON). This is the ONLY input shape the AI service
accepts: the service is stateless and never queries MySQL. Keep the two in sync; bump payloadVersion on any
breaking change.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class ScoringPayload(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    payloadVersion: int = Field(1, ge=1, le=1)

    # Traceability only — never used as model features.
    prescriptionId: str | None = None
    versionNumber: int | None = Field(None, ge=1)
    patientId: str | None = None
    providerId: str | None = None
    referenceTime: str | None = None

    drugName: str = Field(min_length=1)
    drugClass: str = Field(min_length=1)
    doseValue: str | float = Field(description="Exact decimal string from MySQL, e.g. '500.000'")
    doseUnit: str = Field(min_length=1)
    frequency: str = Field(min_length=1)
    durationDays: int = Field(ge=0)
    route: str = "oral"

    patientAge: int = Field(ge=0, le=130)
    patientWeight: float | None = Field(None, gt=0, le=400)
    patientWeightIsDefault: bool = False
    # Module 15: recorded on the prescription (cm). Carried for traceability — NOT a model feature.
    patientHeight: float | None = Field(None, gt=0, le=300)

    # drugCombinationFlag is computed in Node from TWO sources: other active prescriptions (overlappingPrescriptionIds)
    # and other medicines on the same submission (siblingSameClassCount, Module 15).
    drugCombinationFlag: bool = False
    overlappingPrescriptionIds: list[str] = Field(default_factory=list)
    siblingSameClassCount: int = Field(0, ge=0)
    providerDrugClassHistory: dict[str, int] = Field(default_factory=dict)
    patientVelocity: int = Field(0, ge=0)
