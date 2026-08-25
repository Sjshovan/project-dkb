"""Lean query-only FastEmbed sidecar for the DKB runtime.

It never reads package sources or creates chunks. It only places an incoming
search question in the same vector space as the compiler output.
"""

import os
from fastapi import FastAPI
from pydantic import BaseModel
from llama_index.core import Settings
from llama_index.embeddings.fastembed import FastEmbedEmbedding

MODEL = os.environ.get("DKB_FASTEMBED_MODEL", "BAAI/bge-small-en-v1.5")
Settings.embed_model = FastEmbedEmbedding(model_name=MODEL, cache_dir=os.environ.get("FASTEMBED_CACHE_PATH"))
app = FastAPI()

class EmbedRequest(BaseModel):
    texts: list[str]

@app.get("/health")
def health():
    return {"ok": True, "model": MODEL}

@app.post("/embed")
def embed(request: EmbedRequest):
    return {"model": MODEL, "vectors": Settings.embed_model.get_text_embedding_batch(request.texts)}
