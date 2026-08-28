from __future__ import annotations

import asyncio
import json
import os
import re
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

import compile as compiler

SERVICE_VERSION = "3"
DEFAULT_MODEL = os.environ.get("DKB_COMPILER_MODEL", "BAAI/bge-small-en-v1.5")
JOBS_ROOT = Path(os.environ.get("DKB_COMPILER_JOBS_ROOT", "/jobs"))
JOB_ID_PATTERN = re.compile(r"^[a-zA-Z0-9._-]+$")

app = FastAPI()
compile_lock = asyncio.Lock()


class CompileRequest(BaseModel):
    jobId: str = Field(min_length=1)
    request: dict[str, Any]
    model: str | None = None
    workers: int | None = None


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "dkb.llamaindex.compiler",
        "serviceVersion": SERVICE_VERSION,
        "compilerId": "llamaindex.docling.evidence",
        "model": DEFAULT_MODEL,
        "jobsRoot": str(JOBS_ROOT),
        "batching": {
            "documentBatchSize": compiler.DOCUMENT_BATCH_SIZE,
        },
    }


@app.post("/compile")
async def compile_job(payload: CompileRequest) -> dict[str, Any]:
    if not JOB_ID_PATTERN.match(payload.jobId):
        raise HTTPException(status_code=400, detail="jobId may contain only letters, numbers, dots, dashes, and underscores")

    job_root = (JOBS_ROOT / payload.jobId).resolve()
    try:
        job_root.relative_to(JOBS_ROOT.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="jobId resolves outside compiler jobs root") from exc

    input_root = job_root / "input"
    output_root = job_root / "output"
    request_root = job_root / "request"
    request_file = request_root / "request.json"
    output_file = output_root / "llamaindex-compiled.json"

    if not input_root.exists():
        raise HTTPException(status_code=400, detail=f"job input root does not exist: {input_root}")

    request_root.mkdir(parents=True, exist_ok=True)
    output_root.mkdir(parents=True, exist_ok=True)
    request_file.write_text(json.dumps(payload.request, sort_keys=True), encoding="utf-8")

    async with compile_lock:
        started = time.perf_counter()
        reset_compiler_state(payload.model or DEFAULT_MODEL, payload.workers)
        compiler.REQUEST = request_file
        compiler.OUTPUT = output_file
        compiler.INPUT_ROOT = input_root
        try:
            await compiler.main_async()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    parsed = json.loads(output_file.read_text(encoding="utf-8"))
    execution = parsed.setdefault("execution", {})
    service_timings = execution.setdefault("serviceTimingsMs", {})
    service_timings["jobWall"] = round((time.perf_counter() - started) * 1000, 3)
    return parsed


def reset_compiler_state(model: str, workers: int | None) -> None:
    compiler.MODEL = model
    compiler.ASYNC_WORKERS = max(1, min(4, int(workers or os.environ.get("DKB_LLAMA_ASYNC_WORKERS", "1"))))
    compiler._COMPILER_TIMINGS = {
        "doclingTokenizer": 0.0,
        "doclingConversion": 0.0,
        "doclingChunk": 0.0,
    }
    compiler._DOCLING_FILES = 0
    compiler._DOCLING_FALLBACKS = 0
