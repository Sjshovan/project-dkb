from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import faiss
import numpy as np


def load_vectors(path: Path) -> tuple[np.ndarray, np.ndarray]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    vectors = np.asarray(payload["vectors"], dtype="float32")
    ids = np.asarray([int(item) for item in payload["ids"]], dtype="int64")
    if len(vectors.shape) != 2 or vectors.shape[0] != ids.shape[0]:
        raise RuntimeError("Invalid FAISS vector payload")
    faiss.normalize_L2(vectors)
    return vectors, ids


def build_index(vectors_path: Path, output_path: Path) -> dict[str, Any]:
    vectors, ids = load_vectors(vectors_path)
    index = faiss.IndexIDMap2(faiss.IndexFlatIP(int(vectors.shape[1])))
    index.add_with_ids(vectors, ids)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    faiss.write_index(index, str(output_path))
    return {
        "ok": True,
        "path": str(output_path),
        "count": int(index.ntotal),
        "dimensions": int(vectors.shape[1]),
        "faissVersion": faiss.__version__,
    }


class FaissServer:
    def __init__(self) -> None:
        self.index: Any | None = None
        self.dimensions = 0

    def handle(self, request: dict[str, Any]) -> dict[str, Any]:
        op = request.get("op")
        if op == "health":
            return {"ok": True, "faissVersion": faiss.__version__}
        if op == "load":
            return self.load(request)
        if op == "search":
            return self.search(request)
        if op == "close":
            return {"ok": True, "closed": True}
        raise RuntimeError(f"Unknown FAISS helper operation: {op}")

    def load(self, request: dict[str, Any]) -> dict[str, Any]:
        segments = request.get("segments")
        dimensions = int(request.get("dimensions") or 0)
        if not isinstance(segments, list) or dimensions <= 0:
            raise RuntimeError("FAISS load requires segments and dimensions")
        master = faiss.IndexShards(dimensions, False, False)
        total = 0
        for segment in segments:
            if not isinstance(segment, dict) or not isinstance(segment.get("path"), str):
                raise RuntimeError("Invalid FAISS segment")
            index = faiss.read_index(segment["path"])
            if int(index.d) != dimensions:
                raise RuntimeError(f"FAISS segment dimension mismatch: expected {dimensions}, got {int(index.d)}")
            master.add_shard(index)
            total += int(index.ntotal)
        self.index = master
        self.dimensions = dimensions
        return {"ok": True, "count": total, "dimensions": dimensions, "shards": len(segments)}

    def search(self, request: dict[str, Any]) -> dict[str, Any]:
        if self.index is None:
            raise RuntimeError("FAISS index is not loaded")
        vector = np.asarray([request.get("vector")], dtype="float32")
        limit = max(1, min(int(request.get("limit") or 10), 1000))
        if len(vector.shape) != 2 or int(vector.shape[1]) != self.dimensions:
            raise RuntimeError("FAISS query vector dimension mismatch")
        faiss.normalize_L2(vector)
        scores, labels = self.index.search(vector, limit)
        hits = [
            {"id": str(int(label)), "score": float(score)}
            for label, score in zip(labels[0].tolist(), scores[0].tolist())
            if int(label) != -1
        ]
        return {"ok": True, "hits": hits}


def serve() -> int:
    server = FaissServer()
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
            response = server.handle(request)
        except Exception as exc:  # noqa: BLE001 - surfaced to TypeScript boundary
            response = {"ok": False, "error": str(exc)}
        sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
        sys.stdout.flush()
        if response.get("closed"):
            return 0
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build")
    build.add_argument("--vectors", required=True)
    build.add_argument("--out", required=True)
    sub.add_parser("serve")
    args = parser.parse_args()
    if args.command == "build":
        print(json.dumps(build_index(Path(args.vectors), Path(args.out)), indent=2))
        return 0
    if args.command == "serve":
        return serve()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
