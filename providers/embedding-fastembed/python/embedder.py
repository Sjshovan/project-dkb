"""Lean FastEmbed sidecar for DKB document and query embeddings.

It never reads package sources or creates chunks. It only places an incoming
document or search question in the selected retrieval space.
"""

import os
from fastapi import FastAPI
from fastembed import TextEmbedding
from pydantic import BaseModel, Field

MODEL = os.environ.get("DKB_FASTEMBED_MODEL", "BAAI/bge-small-en-v1.5")
MAX_BATCH_SIZE = 128
INTERNAL_BATCH_SIZE = min(max(int(os.environ.get("DKB_FASTEMBED_BATCH_SIZE", "32")), 1), MAX_BATCH_SIZE)
THREADS = int(os.environ["DKB_FASTEMBED_THREADS"]) if os.environ.get("DKB_FASTEMBED_THREADS") else None
embedding_model = TextEmbedding(
    model_name=MODEL,
    cache_dir=os.environ.get("FASTEMBED_CACHE_PATH"),
    threads=THREADS,
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
        "mode": request.mode,
        "vectors": [vector.tolist() for vector in vectors],
    }
