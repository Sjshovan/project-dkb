from __future__ import annotations

from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import re
from typing import Any

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from worker_control import JobError, WorkerControl

SERVICE_VERSION = "5"
DEFAULT_MODEL = os.environ.get("DKB_COMPILER_MODEL", "BAAI/bge-small-en-v1.5")
JOBS_ROOT = Path(os.environ.get("DKB_COMPILER_JOBS_ROOT", "/jobs"))
MODEL_PINS = json.loads(Path(__file__).with_name("model-pins.json").read_text())
DOCUMENT_BATCH_SIZE = max(1, min(256, int(os.environ.get("DKB_LLAMA_DOCUMENT_BATCH_SIZE", "32"))))
control = WorkerControl(JOBS_ROOT)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await control.start()
    try:
        yield
    finally:
        await control.close()


app = FastAPI(lifespan=lifespan)


class JobIdentity(BaseModel):
    model_config = ConfigDict(extra="forbid")
    jobId: str = Field(min_length=1, max_length=128)
    jobToken: str = Field(min_length=32, max_length=128)


class CompileRequest(JobIdentity):
    deadline: str = Field(min_length=1, max_length=64)
    request: dict[str, Any]
    model: str | None = None
    modelRevision: str | None = None
    evidenceOptions: dict[str, Any] | None = None
    workers: int | None = Field(default=None, ge=1, le=4)


@app.exception_handler(JobError)
async def job_error_handler(request, error: JobError):
    return JSONResponse(status_code=error.http_status, content={
        "error": error.code, "message": str(error), **({"job": error.job} if error.job else {}),
    })


@app.exception_handler(RequestValidationError)
async def invalid_request_handler(request, error: RequestValidationError):
    # Pydantic's default validation response can reflect the raw job token.
    return JSONResponse(status_code=422, content={
        "error": "invalid_worker_request", "message": "A valid worker job request is required.",
    })


@app.get("/health")
def health() -> JSONResponse:
    ready = control.started and not control.blocked and not control.closing
    return JSONResponse(status_code=200 if ready else 503, content={
        "ok": ready, "service": "dkb.llamaindex.compiler", "serviceVersion": SERVICE_VERSION,
        "compilerId": "llamaindex.docling.evidence", "model": DEFAULT_MODEL,
        "jobsRoot": str(JOBS_ROOT), "batching": {"documentBatchSize": DOCUMENT_BATCH_SIZE},
        "jobControl": {"format": "dkb.evidence.worker-job.v1", "persistentChild": True},
    })


@app.post("/compile")
async def compile_job(payload: CompileRequest) -> dict[str, Any]:
    model = payload.model or DEFAULT_MODEL
    revision = payload.modelRevision or MODEL_PINS.get(model)
    if not isinstance(revision, str) or not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise JobError("invalid_model_revision", "modelRevision must be an immutable model commit.")
    options = payload.evidenceOptions or {}
    allowed = {"richFiles", "richFileFallback", "richFileExtensions", "ocrBackend", "ocrLanguage"}
    extensions = {".pdf", ".docx", ".pptx", ".xlsx", ".html", ".htm"}
    if set(options) - allowed or any(key in options and not isinstance(options[key], bool) for key in ("richFiles", "richFileFallback")):
        raise JobError("invalid_evidence_options", "Invalid Evidence extraction options.")
    selected_extensions = options.get("richFileExtensions", sorted(extensions))
    if not isinstance(selected_extensions, list) or any(not isinstance(item, str) or item not in extensions for item in selected_extensions):
        raise JobError("invalid_evidence_options", "Unsupported richFileExtensions.")
    backend, language = options.get("ocrBackend", "torch"), options.get("ocrLanguage", "ch")
    if not isinstance(backend, str) or backend not in {"torch", "onnxruntime"} or not isinstance(language, str) or language not in {"ch", "en"}:
        raise JobError("invalid_evidence_options", "Unsupported pinned OCR backend or language.")
    return await control.compile({**payload.model_dump(), "model": model, "modelRevision": revision,
                                  "evidenceOptions": options, "workers": payload.workers or 1})


@app.post("/jobs/status")
async def job_status(payload: JobIdentity) -> dict[str, Any]:
    return await control.status(payload.jobId, payload.jobToken)


@app.post("/jobs/cancel")
async def cancel_job(payload: JobIdentity) -> JSONResponse:
    result = await control.cancel(payload.jobId, payload.jobToken)
    return JSONResponse(status_code=202 if not result["safeToCleanup"] else 200, content=result)
