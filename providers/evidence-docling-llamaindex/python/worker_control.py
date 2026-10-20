"""Single-child execution ownership and durable, job-scoped cancellation."""
from __future__ import annotations

import asyncio
import ctypes
import fcntl
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import re
import signal
import sys
import time
from datetime import datetime
from typing import Any
from uuid import uuid4

FORMAT = "dkb.evidence.worker-job.v1"
TERMINAL = {"completed", "failed", "cancelled"}
MAX_DEADLINE_SECONDS = 24 * 60 * 60
MAX_PENDING = 128
MAX_RECORDS = 4096


class JobError(Exception):
    def __init__(self, code: str, message: str, http_status: int = 400, job: dict | None = None):
        super().__init__(message)
        self.code, self.http_status, self.job = code, http_status, job


def job_identity(job_id: str, token: str) -> str:
    if not isinstance(job_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", job_id):
        raise JobError("invalid_job_identity", "A bounded, safe jobId is required.")
    if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token):
        raise JobError("invalid_job_identity", "A job credential is required.")
    return "sha256:" + hashlib.sha256(token.encode()).hexdigest()


def deadline_seconds(value: str) -> float:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
        result = parsed.timestamp()
        if result > time.time() + MAX_DEADLINE_SECONDS:
            raise ValueError()
        return result
    except (AttributeError, TypeError, ValueError, OverflowError) as exc:
        raise JobError("invalid_job_deadline", "A deadline no more than 24 hours in the future is required.") from exc


def envelope(record: dict) -> dict:
    return {key: record[key] for key in ("format", "jobId", "jobTokenHash", "status", "safeToCleanup", "terminated", "reason") if key in record}


def valid_record(record: Any) -> bool:
    if not isinstance(record, dict) or record.get("format") != FORMAT:
        return False
    if not isinstance(record.get("jobId"), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", record["jobId"]):
        return False
    if not isinstance(record.get("jobTokenHash"), str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", record["jobTokenHash"]):
        return False
    if record.get("status") not in TERMINAL | {"queued", "running", "cancelling"}:
        return False
    if not isinstance(record.get("safeToCleanup"), bool) or not isinstance(record.get("terminated"), bool):
        return False
    if not isinstance(record.get("updatedAt"), (int, float)) or not math.isfinite(record["updatedAt"]):
        return False
    worker = record.get("worker")
    return worker is None or (
        isinstance(worker, dict) and type(worker.get("pid")) is int and worker["pid"] > 1
        and isinstance(worker.get("start"), str) and worker["start"].isdigit()
        and isinstance(worker.get("generation"), str) and bool(re.fullmatch(r"[a-f0-9]{32}", worker["generation"]))
        and isinstance(worker.get("bootId"), str) and bool(re.fullmatch(r"[a-f0-9-]{36}", worker["bootId"]))
        and isinstance(worker.get("namespace"), str) and bool(re.fullmatch(r"pid:\[\d+\]", worker["namespace"]))
    )


def atomic_json(target: Path, value: dict) -> None:
    temporary = target.with_name(target.name + "." + uuid4().hex + ".tmp")
    try:
        with temporary.open("x", encoding="utf-8") as output:
            os.chmod(temporary, 0o600)
            json.dump(value, output, sort_keys=True, separators=(",", ":"))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, target)
        descriptor = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        temporary.unlink(missing_ok=True)


def process_identity(pid: int) -> dict | None:
    try:
        # comm may contain spaces or parentheses; fields after its final ')' are stable.
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return {"pid": pid, "parent": int(fields[1]), "group": int(fields[2]),
                "session": int(fields[3]), "start": fields[19], "state": fields[0]}
    except (FileNotFoundError, ProcessLookupError):
        return None


class WorkerControl:
    def __init__(self, root: Path, *, worker_command: list[str] | None = None, terminate_grace: float = 2.0):
        self.root = root.resolve()
        self.control_root = self.root / ".control"
        self.worker_command = worker_command or [sys.executable, str(Path(__file__).with_name("worker.py"))]
        self.terminate_grace = terminate_grace
        self.records: dict[str, dict] = {}
        self.events: dict[str, asyncio.Event] = {}
        self.tasks: dict[str, asyncio.Task] = {}
        self.deadlines: dict[str, asyncio.Task] = {}
        self.lock = asyncio.Lock()
        self.slot = asyncio.Lock()
        self.child: dict | None = None
        self.owner_file = None
        self.started = False
        self.blocked = False
        self.closing = False

    async def start(self) -> None:
        if self.started:
            return
        if sys.platform != "linux" or os.getpid() != 1:
            raise RuntimeError("Evidence worker ownership requires the supported Linux container.")
        self.control_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.owner_file = (self.control_root / "owner.lock").open("a")
        try:
            fcntl.flock(self.owner_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            self.owner_file.close()
            self.owner_file = None
            raise RuntimeError("Another supervisor owns these Evidence jobs; use one HTTP worker.") from exc
        try:
            libc = ctypes.CDLL(None, use_errno=True)
            if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
                raise RuntimeError("Evidence worker cannot establish descendant ownership.")
            self.boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
            self.namespace = os.readlink("/proc/self/ns/pid")
            for index, target in enumerate(self.control_root.glob("*.json")):
                if index >= MAX_RECORDS or target.stat().st_size > 16_384:
                    raise RuntimeError("Evidence job journal exceeds its bounded capacity.")
                record = json.loads(target.read_text())
                if not valid_record(record) or target != self.record_path(record["jobId"]):
                    raise RuntimeError("Invalid Evidence job journal; preserve it for recovery.")
                self.records[record["jobId"]] = record
                self.events[record["jobId"]] = asyncio.Event()
            for record in self.records.values():
                if record["status"] not in TERMINAL or not record["safeToCleanup"]:
                    worker = record.get("worker")
                    if worker and worker.get("bootId") == self.boot_id and worker.get("namespace") == self.namespace:
                        await self.stop_group(worker)
                    self.finish(record, "cancelled" if record["status"] == "cancelling" else "failed", True, "worker_restarted")
                else:
                    self.events[record["jobId"]].set()
            self.started = True
        except BaseException:
            self.owner_file.close()
            self.owner_file = None
            raise

    def record_path(self, job_id: str) -> Path:
        return self.control_root / (hashlib.sha256(job_id.encode()).hexdigest() + ".json")

    def save(self, record: dict) -> None:
        record["updatedAt"] = time.time()
        atomic_json(self.record_path(record["jobId"]), record)

    def finish(self, record: dict, status: str, terminated: bool, reason: str | None = None) -> None:
        updated = {**record, "status": status, "safeToCleanup": True, "terminated": terminated}
        if reason:
            updated["reason"] = reason
        self.save(updated)
        record.clear()
        record.update(updated)
        self.events[record["jobId"]].set()
        deadline = self.deadlines.pop(record["jobId"], None)
        if deadline and deadline is not asyncio.current_task():
            deadline.cancel()

    def authenticate(self, job_id: str, token_hash: str) -> dict:
        record = self.records.get(job_id)
        if record is None:
            raise JobError("job_unknown", "Worker job is unknown; termination is not confirmed.", 404)
        if not hmac.compare_digest(record["jobTokenHash"], token_hash):
            raise JobError("job_unauthorized", "Worker job credential does not match.", 403)
        return record

    def prune(self) -> None:
        for job_id, record in list(self.records.items()):
            if record["status"] in TERMINAL and record["safeToCleanup"] and record["updatedAt"] < time.time() - MAX_DEADLINE_SECONDS:
                self.record_path(job_id).unlink()
                self.records.pop(job_id)
                self.events.pop(job_id, None)

    async def compile(self, payload: dict) -> dict:
        job_id, token_hash = payload["jobId"], job_identity(payload["jobId"], payload["jobToken"])
        expiry = deadline_seconds(payload["deadline"])
        hashed = {key: value for key, value in payload.items() if key != "jobToken"}
        request_digest = hashlib.sha256(json.dumps(hashed, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        async with self.lock:
            if self.closing or self.blocked:
                raise JobError("worker_unavailable", "Worker ownership must be reconciled before admitting another job.", 503)
            record = self.records.get(job_id)
            if record:
                self.authenticate(job_id, token_hash)
                if record.get("requestDigest") not in {None, request_digest}:
                    raise JobError("job_conflict", "Worker job identity is already bound to another request.", 409, envelope(record))
            else:
                self.prune()
                if len(self.records) >= MAX_RECORDS or sum(item["status"] not in TERMINAL for item in self.records.values()) >= MAX_PENDING:
                    raise JobError("worker_busy", "Worker job capacity is full; retry after existing work settles.", 503)
                job_root = self.root / job_id
                if not (job_root / "input").is_dir() or job_root.is_symlink():
                    raise JobError("job_input_missing", "The owned worker input directory is required.")
                if job_root.resolve().parent != self.root:
                    raise JobError("invalid_job_root", "Worker job directory escapes its owned root.")
                if any((job_root / name).is_symlink() or (job_root / name).resolve().parent != job_root for name in ("input", "request", "output")):
                    raise JobError("invalid_job_root", "Worker job paths must remain in their owned directory.")
                record = {"format": FORMAT, "jobId": job_id, "jobTokenHash": token_hash,
                          "requestDigest": request_digest, "deadline": expiry, "status": "queued",
                          "safeToCleanup": False, "terminated": False}
                self.records[job_id] = record
                self.events[job_id] = asyncio.Event()
                self.save(record)
                if expiry <= time.time():
                    self.finish(record, "cancelled", True, "deadline_expired")
                else:
                    (job_root / "request").mkdir(exist_ok=True)
                    (job_root / "output").mkdir(exist_ok=True)
                    atomic_json(job_root / "request" / "request.json", payload["request"])
                    task = asyncio.create_task(self.execute(job_id, payload))
                    self.tasks[job_id] = task
                    task.add_done_callback(lambda done, key=job_id: self.task_done(key, done))
                    self.deadlines[job_id] = asyncio.create_task(self.expire(job_id, expiry))
        await asyncio.shield(self.events[job_id].wait())
        record = self.records[job_id]
        job = envelope(record)
        if record["status"] != "completed":
            raise JobError("compile_cancelled" if record["status"] == "cancelled" else "compile_termination_unconfirmed" if not record["safeToCleanup"] else "compile_failed",
                           "Evidence work did not complete successfully.", 409 if record["status"] == "cancelled" else 503 if not record["safeToCleanup"] else 500, job)
        try:
            output = json.loads((self.root / job_id / "output" / "llamaindex-compiled.json").read_text())
        except (FileNotFoundError, ValueError) as exc:
            raise JobError("job_output_unavailable", "Completed job output is unavailable; its terminal state is retained.", 409, job) from exc
        output["job"] = job
        output.setdefault("execution", {}).setdefault("serviceTimingsMs", {})["jobWall"] = record.get("jobWallMs", 0.0)
        return output

    def task_done(self, job_id: str, task: asyncio.Task) -> None:
        self.tasks.pop(job_id, None)
        if not task.cancelled():
            task.exception()  # Observe errors even after the HTTP caller disconnects.

    async def status(self, job_id: str, token: str) -> dict:
        token_hash = job_identity(job_id, token)
        async with self.lock:
            return envelope(self.authenticate(job_id, token_hash))

    async def cancel(self, job_id: str, token: str) -> dict:
        token_hash = job_identity(job_id, token)
        async with self.lock:
            if job_id not in self.records:
                self.prune()
                if len(self.records) >= MAX_RECORDS:
                    raise JobError("worker_busy", "Worker cancellation journal capacity is full.", 503)
                record = {"format": FORMAT, "jobId": job_id, "jobTokenHash": token_hash,
                          "status": "cancelled", "safeToCleanup": True, "terminated": True,
                          "reason": "cancelled_before_start"}
                self.save(record)
                self.records[job_id] = record
                self.events[job_id] = asyncio.Event()
                self.events[job_id].set()
                return envelope(record)
            record = self.authenticate(job_id, token_hash)
            self.request_cancel(record, "cancel_requested")
            return envelope(record)

    def request_cancel(self, record: dict, reason: str) -> None:
        if record["status"] in TERMINAL:
            return
        if record["status"] == "queued":
            self.finish(record, "cancelled", True, reason)
            task = self.tasks.get(record["jobId"])
            if task:
                task.cancel()
            return
        record.update(status="cancelling", reason=reason, safeToCleanup=False, terminated=False)
        self.save(record)
        child = self.child
        if child and record.get("worker", {}).get("generation") == child["generation"]:
            self.begin_stop(record, child)
        else:
            self.blocked = True
            record["reason"] = "worker_ownership_unconfirmed"
            self.save(record)
            self.events[record["jobId"]].set()

    async def expire(self, job_id: str, expiry: float) -> None:
        await asyncio.sleep(max(0, expiry - time.time()))
        async with self.lock:
            self.request_cancel(self.records[job_id], "deadline_expired")

    async def spawn(self) -> dict:
        process = await asyncio.create_subprocess_exec(*self.worker_command, stdin=asyncio.subprocess.PIPE,
                                                       stdout=asyncio.subprocess.PIPE, start_new_session=True)
        identity = process_identity(process.pid)
        if not identity or identity["group"] != process.pid or identity["session"] != process.pid:
            process.kill()
            await process.wait()
            raise RuntimeError("Worker process ownership could not be established.")
        return {**identity, "bootId": self.boot_id, "namespace": self.namespace,
                "generation": uuid4().hex, "process": process, "ready": False}

    async def message(self, child: dict) -> dict:
        line = await child["process"].stdout.readline()
        if not line:
            raise RuntimeError("Worker control channel closed.")
        return json.loads(line)

    async def execute(self, job_id: str, payload: dict) -> None:
        child = None
        async with self.slot:
            started = time.perf_counter()
            try:
                async with self.lock:
                    record = self.records[job_id]
                    if record["status"] in TERMINAL:
                        return
                    if self.blocked or self.closing:
                        # This job never reached the child. Do not reuse a
                        # prior job's channel after an unconfirmed stop.
                        self.finish(record, "failed", True, "worker_unavailable_before_dispatch")
                        return
                    if self.child is None:
                        self.child = await self.spawn()
                    child = self.child
                    record.update(status="running", worker={key: child[key] for key in ("pid", "start", "bootId", "namespace", "generation")})
                    self.save(record)
                if not child["ready"]:
                    ready = await self.message(child)
                    if ready != {"event": "ready", "pid": child["pid"]}:
                        raise RuntimeError("Worker startup acknowledgement does not match its process.")
                    child["ready"] = True
                async with self.lock:
                    if record["status"] != "running":
                        stop = self.begin_stop(record, child)
                    else:
                        command = {key: value for key, value in payload.items() if key not in {"jobToken", "deadline", "request"}}
                        command["jobRoot"] = str(self.root / job_id)
                        child["process"].stdin.write((json.dumps(command) + "\n").encode())
                        stop = None
                if stop:
                    await stop
                    return
                await child["process"].stdin.drain()
                result = await self.message(child)
                if result.get("event") != "finished" or result.get("jobId") != job_id or result.get("ok") is not True:
                    raise RuntimeError("Worker execution failed or its acknowledgement did not match.")
                async with self.lock:
                    if record["status"] == "running":
                        record["jobWallMs"] = round((time.perf_counter() - started) * 1000, 3)
                        self.finish(record, "completed", False)
                        return
                    stop = self.begin_stop(record, child)
                await stop
            except asyncio.CancelledError:
                if child:
                    await self.begin_stop(self.records[job_id], child)
                raise
            except Exception:
                if child:
                    await self.begin_stop(self.records[job_id], child)
                else:
                    async with self.lock:
                        self.finish(self.records[job_id], "failed", True, "worker_start_failed")

    def begin_stop(self, record: dict, child: dict) -> asyncio.Task:
        existing = child.get("stopTask")
        if existing and not (existing.done() and existing.exception()):
            return existing
        task = asyncio.create_task(self.stop_and_finish(record, child))
        child["stopTask"] = task
        return task

    async def stop_and_finish(self, record: dict, child: dict) -> None:
        try:
            await self.stop_group(child)
            async with self.lock:
                if self.child is child:
                    self.child = None
                self.blocked = False
                self.finish(record, "cancelled" if record["status"] == "cancelling" else "failed", True,
                            record.get("reason", "worker_failed"))
        except Exception:
            async with self.lock:
                self.blocked = True
                record.update(status="cancelling", safeToCleanup=False, terminated=False, reason="worker_termination_unconfirmed")
                self.save(record)
                self.events[record["jobId"]].set()
            raise

    async def stop_group(self, child: dict) -> None:
        pid = child["pid"]
        current = process_identity(pid)
        if current and (current["start"] != child["start"] or current["group"] != pid or current["session"] != pid):
            raise RuntimeError("Worker process identity changed; termination is unconfirmed.")
        if pid == os.getpgrp():
            raise RuntimeError("Refusing to terminate the supervisor process group.")
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        await asyncio.sleep(self.terminate_grace)
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process = child.get("process")
        deadline = time.monotonic() + 5
        while True:
            if process is None:
                try:
                    os.waitpid(pid, os.WNOHANG)
                except ChildProcessError:
                    pass
            # PID 1 owns this dedicated service namespace. After the leader
            # exits, it also adopts descendants that created another session;
            # validate each exact process before killing/reaping those too.
            adopted = []
            for entry in Path("/proc").iterdir():
                if not entry.name.isdigit():
                    continue
                identity = process_identity(int(entry.name))
                if identity and identity["parent"] == os.getpid() and identity["pid"] != pid:
                    if int(identity["start"]) < int(child["start"]):
                        raise RuntimeError("An unrelated child prevents unambiguous descendant cleanup.")
                    adopted.append(identity)
            for identity in adopted:
                latest = process_identity(identity["pid"])
                if latest and latest["start"] == identity["start"] and latest["parent"] == os.getpid():
                    try:
                        os.kill(identity["pid"], signal.SIGKILL)
                        os.waitpid(identity["pid"], os.WNOHANG)
                    except ProcessLookupError:
                        pass
                    except ChildProcessError:
                        raise RuntimeError("Descendant ownership could not be confirmed.")
            try:
                os.killpg(pid, 0)
            except ProcessLookupError:
                if not adopted:
                    break
            if time.monotonic() >= deadline:
                raise RuntimeError("Worker descendants have not terminated and been reaped.")
            await asyncio.sleep(0.01)
        # Forked descendants can retain the control pipe even after setsid.
        # Reap them before waiting for asyncio's pipe-aware process completion.
        if process:
            await asyncio.wait_for(process.wait(), 5)
        if process and process.stdin:
            process.stdin.close()

    async def close(self) -> None:
        self.closing = True
        async with self.lock:
            for record in self.records.values():
                if record["status"] not in TERMINAL:
                    self.request_cancel(record, "worker_stopping")
        if self.tasks:
            await asyncio.gather(*list(self.tasks.values()), return_exceptions=True)
        if self.child:
            await self.stop_group(self.child)
            self.child = None
        for task in self.deadlines.values():
            task.cancel()
        if self.owner_file:
            self.owner_file.close()
            self.owner_file = None
        self.started = False
