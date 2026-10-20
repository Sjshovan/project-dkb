"""Lean FastEmbed sidecar for DKB document and query embeddings.

It never reads package sources or creates chunks. It only places an incoming
document or search question in the selected retrieval space.
"""

import os
import json
import re
from pathlib import Path
from fastapi import FastAPI
from fastembed import TextEmbedding
from huggingface_hub import snapshot_download
from pydantic import BaseModel, Field

MODEL = os.environ.get("DKB_FASTEMBED_MODEL", "BAAI/bge-small-en-v1.5")
MODEL_PINS = json.loads(Path(__file__).with_name("model-pins.json").read_text(encoding="utf-8"))
DEFAULT_PIN = MODEL_PINS.get(MODEL, {})
MODEL_REPOSITORY = os.environ.get("DKB_FASTEMBED_MODEL_REPOSITORY") or DEFAULT_PIN.get("repository")
MODEL_REVISION = os.environ.get("DKB_FASTEMBED_MODEL_REVISION") or (
    DEFAULT_PIN.get("revision") if MODEL_REPOSITORY == DEFAULT_PIN.get("repository") else None
)
if not isinstance(MODEL_REPOSITORY, str) or not re.fullmatch(r"[A-Za-z0-9._-]+/[A-Za-z0-9._-]+", MODEL_REPOSITORY):
    raise RuntimeError("DKB_FASTEMBED_MODEL_REPOSITORY must name the exact ONNX model repository")
if not isinstance(MODEL_REVISION, str) or not re.fullmatch(r"[a-f0-9]{40}", MODEL_REVISION):
    raise RuntimeError("DKB_FASTEMBED_MODEL_REVISION must be an immutable 40-character model commit")
MODEL_PATH = snapshot_download(
    repo_id=MODEL_REPOSITORY,
    revision=MODEL_REVISION,
    cache_dir=os.environ.get("FASTEMBED_CACHE_PATH"),
    allow_patterns=["*.json", "*.onnx", "*.onnx_data", "*.txt", "*.model"],
)
MAX_BATCH_SIZE = 128
INTERNAL_BATCH_SIZE = min(max(int(os.environ.get("DKB_FASTEMBED_BATCH_SIZE", "32")), 1), MAX_BATCH_SIZE)
THREADS = int(os.environ["DKB_FASTEMBED_THREADS"]) if os.environ.get("DKB_FASTEMBED_THREADS") else None
embedding_model = TextEmbedding(
    model_name=MODEL,
    cache_dir=os.environ.get("FASTEMBED_CACHE_PATH"),
    threads=THREADS,
    specific_model_path=MODEL_PATH,
    local_files_only=True,
)
app = FastAPI()

class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=MAX_BATCH_SIZE)
    mode: str = "document"

@app.get("/health")
def health():
    return {
        "ok": True,
        "model": MODEL,
        "modelRepository": MODEL_REPOSITORY,
        "modelRevision": MODEL_REVISION,
        "engine": "fastembed",
        "maxBatchSize": MAX_BATCH_SIZE,
        "batchSize": INTERNAL_BATCH_SIZE,
    }

@app.post("/embed")
def embed(request: EmbedRequest):
    if request.mode == "query":
        vectors = embedding_model.query_embed(request.texts)
    elif request.mode == "document":
        vectors = embedding_model.embed(request.texts, batch_size=INTERNAL_BATCH_SIZE)
    else:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="mode must be document or query")

    return {
        "model": MODEL,
        "modelRepository": MODEL_REPOSITORY,
        "modelRevision": MODEL_REVISION,
        "mode": request.mode,
        "vectors": [vector.tolist() for vector in vectors],
    }
