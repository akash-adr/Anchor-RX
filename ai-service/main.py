"""
Anchor Rx AI risk engine — HTTP wrapper (Module 8). Stateless: JSON in, JSON out; never touches MySQL.

Run from ai-service/:
    .venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000

    GET  /health   service + model status
    POST /score    body: ScoringPayload v1, exactly as backend/ml/buildScoringPayload.js produces it
                   200 → { risk_score, risk_band, reasons, details }   422 → invalid payload
Port 8000: the Node API uses 4000 and the Vite portal 5173. Bound to localhost; only the Node backend should call it.
"""

from __future__ import annotations

import time
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel

from features.extract import FeatureExtractionError
from features.payload import ScoringPayload
from inference.score import score_prescription
from train.artifacts import load_artifacts


class Reason(BaseModel):
    source: Literal["rule_engine", "ml_model"]
    feature: str
    explanation: str


class NotEvaluatedRule(BaseModel):
    rule: str
    reason: str


class ScoreDetails(BaseModel):
    ml_subscore: float
    rule_subscore: int
    rules_not_evaluated: list[NotEvaluatedRule]
    patient_weight_is_default: bool
    model_version: str | None


class ScoreResponse(BaseModel):
    risk_score: int
    risk_band: Literal["low", "review", "high"]
    reasons: list[Reason]
    details: ScoreDetails


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.artifacts = load_artifacts()  # fail fast at startup if the model artifacts are missing
    yield


app = FastAPI(title="Anchor Rx AI risk engine", version="1.0.0", lifespan=lifespan)


@app.get("/health")
def health(request: Request) -> dict[str, Any]:
    metadata = request.app.state.artifacts.metadata
    return {
        "status": "ok",
        "model_version": metadata.get("model_version"),
        "trained_at": metadata.get("trained_at"),
        "corpus_rows": metadata.get("corpus", {}).get("rows"),
        "scikit_learn": metadata.get("versions", {}).get("scikit_learn"),
    }


@app.post("/score", response_model=ScoreResponse)
def score(payload: ScoringPayload, request: Request, response: Response) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        result = score_prescription(payload, request.app.state.artifacts)
    except FeatureExtractionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    response.headers["X-Scoring-Time-Ms"] = f"{(time.perf_counter() - started) * 1000:.2f}"
    return result
