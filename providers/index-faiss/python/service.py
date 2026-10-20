from __future__ import annotations

import os
import threading
import uuid
from pathlib import Path
from typing import Any

import faiss
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from faiss_helper import FaissServer, build_index


class BuildRequest(BaseModel):
    vectors: str
    output: str


class Segment(BaseModel):
    path: str


class LoadRequest(BaseModel):
    dimensions: int = Field(gt=0)
    segments: list[Segment]


class SearchRequest(BaseModel):
    vector: list[float]
    limit: int = Field(default=10, ge=1, le=1000)


class Session:
    def __init__(self, server: FaissServer) -> None:
        self.server = server
        self.lock = threading.Lock()


app = FastAPI(title="DKB FAISS Provider", version="1")
sessions: dict[str, Session] = {}
sessions_lock = threading.Lock()
max_sessions = max(1, int(os.getenv("DKB_FAISS_MAX_SESSIONS", "64")))


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "serviceVersion": "1", "faissVersion": faiss.__version__, "sessions": len(sessions)}


@app.post("/build")
def build(request: BuildRequest) -> dict[str, Any]:
    vectors = allowed_path(request.vectors, must_exist=True)
    output = allowed_path(request.output, must_exist=False)
    try:
        return build_index(vectors, output)
    except Exception as exc:  # noqa: BLE001 - converted to an HTTP provider boundary
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/sessions")
def load(request: LoadRequest) -> dict[str, Any]:
    with sessions_lock:
        if len(sessions) >= max_sessions:
            raise HTTPException(status_code=503, detail=f"FAISS session limit reached ({max_sessions})")

    server = FaissServer()
    payload = {
        "op": "load",
        "dimensions": request.dimensions,
        "segments": [{"path": str(allowed_path(item.path, must_exist=True))} for item in request.segments],
    }
    try:
        result = server.load(payload)
    except Exception as exc:  # noqa: BLE001 - converted to an HTTP provider boundary
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    session_id = uuid.uuid4().hex
    with sessions_lock:
        sessions[session_id] = Session(server)
    return {**result, "sessionId": session_id}


@app.post("/sessions/{session_id}/search")
def search(session_id: str, request: SearchRequest) -> dict[str, Any]:
    session = sessions.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="FAISS session not found")
    try:
        with session.lock:
            return session.server.search({"op": "search", "vector": request.vector, "limit": request.limit})
    except Exception as exc:  # noqa: BLE001 - converted to an HTTP provider boundary
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.delete("/sessions/{session_id}")
def close(session_id: str) -> dict[str, Any]:
    with sessions_lock:
        removed = sessions.pop(session_id, None)
    return {"ok": True, "closed": removed is not None}


def allowed_path(value: str, *, must_exist: bool) -> Path:
    target = Path(value).resolve()
    roots = [Path(item).resolve() for item in os.getenv("DKB_FAISS_ALLOWED_ROOTS", "").split(",") if item.strip()]
    if not roots:
        raise HTTPException(status_code=500, detail="DKB_FAISS_ALLOWED_ROOTS is not configured")
    if not any(target == root or root in target.parents for root in roots):
        raise HTTPException(status_code=403, detail=f"Path is outside the configured FAISS roots: {target}")
    if must_exist and not target.exists():
        raise HTTPException(status_code=404, detail=f"Path does not exist: {target}")
    return target
