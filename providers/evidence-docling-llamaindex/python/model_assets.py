"""Selected Docling assets only; no implicit all-model download or mutable pin."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from urllib.request import Request, urlopen

MANIFEST = json.loads(Path(__file__).with_name("assets.json").read_text(encoding="utf-8"))
DEFAULT_ROOT = Path("/compiler/models")


class ModelIntegrityError(RuntimeError):
    pass


def selected_assets(backend: str) -> list[dict]:
    if backend not in MANIFEST["ocr"]:
        raise ModelIntegrityError(f"No pinned OCR assets for backend {backend}")
    return MANIFEST["common"] + MANIFEST["ocr"][backend]


def asset_digest(backend: str) -> str:
    value = {"format": MANIFEST["format"], "assets": selected_assets(backend)}
    payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def verify_assets(backend: str, root: Path = DEFAULT_ROOT) -> None:
    for asset in selected_assets(backend):
        target = root / asset["path"]
        if not target.is_file() or target.is_symlink():
            raise ModelIntegrityError(f"Missing pinned model asset {asset['path']}; rebuild the selected Evidence worker image")
        with target.open("rb") as source:
            actual = hashlib.file_digest(source, "sha256").hexdigest()
        if actual != asset["sha256"] or ("bytes" in asset and target.stat().st_size != asset["bytes"]):
            raise ModelIntegrityError(f"Pinned model asset failed integrity verification: {asset['path']}")


def download_assets(backend: str, root: Path = DEFAULT_ROOT) -> None:
    for asset in selected_assets(backend):
        target = root / asset["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix + ".download")
        digest = hashlib.sha256()
        count = 0
        try:
            request = Request(asset["url"], headers={"User-Agent": "dkb-evidence-worker/0.1.0"})
            with urlopen(request, timeout=120) as response, temporary.open("wb") as destination:
                while block := response.read(1024 * 1024):
                    count += len(block)
                    if count > asset.get("bytes", 16 * 1024 * 1024):
                        raise ModelIntegrityError(f"Model asset exceeds its expected size: {asset['path']}")
                    digest.update(block)
                    destination.write(block)
            if digest.hexdigest() != asset["sha256"] or ("bytes" in asset and count != asset["bytes"]):
                raise ModelIntegrityError(f"Downloaded model asset failed integrity verification: {asset['path']}")
            os.replace(temporary, target)
            print(json.dumps({"asset": asset["path"], "bytes": count, "sha256": asset["sha256"]}), flush=True)
        finally:
            temporary.unlink(missing_ok=True)
    verify_assets(backend, root)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", choices=sorted(MANIFEST["ocr"]), required=True)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    options = parser.parse_args()
    download_assets(options.backend, options.root)
