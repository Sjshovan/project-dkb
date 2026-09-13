"""Persistent parser child. The HTTP supervisor never imports parser state."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import sys


def main() -> None:
    # Keep a private control channel while routing even native stdout writes to
    # the service log. Descendants do not inherit the control descriptor.
    control = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8")
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())

    import compile as compiler

    def reply(value: dict) -> None:
        control.write(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")
        control.flush()

    reply({"event": "ready", "pid": os.getpid()})
    for line in sys.stdin:
        command = json.loads(line)
        job_id = command["jobId"]
        try:
            model = command["model"]
            revision = command["modelRevision"]
            if compiler.MODEL != model or compiler.MODEL_REVISION != revision:
                compiler._DOCLING_CONVERTER = None
                compiler._DOCLING_CHUNKER = None
            compiler.MODEL = model
            compiler.MODEL_REVISION = revision
            compiler.ASYNC_WORKERS = command["workers"]
            compiler._COMPILER_TIMINGS = {
                "doclingTokenizer": 0.0, "doclingConversion": 0.0, "doclingChunk": 0.0,
            }
            compiler._DOCLING_FILES = 0
            compiler._DOCLING_FALLBACKS = 0
            compiler.configure_evidence(command["evidenceOptions"])
            root = Path(command["jobRoot"])
            compiler.REQUEST = root / "request" / "request.json"
            compiler.OUTPUT = root / "output" / "llamaindex-compiled.json"
            compiler.INPUT_ROOT = root / "input"
            # A fresh loop drains its default executor before returning, even
            # if gather raises while another loader thread remains active.
            # Imported converter/tokenizer objects remain warm in this process.
            asyncio.run(compiler.main_async())
            reply({"event": "finished", "jobId": job_id, "ok": True})
        except Exception as exc:  # noqa: BLE001
            # The supervisor replaces a failed child before acknowledging it;
            # no partially failed parser or unjoined native work is reused.
            reply({"event": "finished", "jobId": job_id, "ok": False,
                   "error": type(exc).__name__})


if __name__ == "__main__":
    main()
