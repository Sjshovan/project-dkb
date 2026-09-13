"""Linux-container, stdlib-only worker ownership tests; no model downloads."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

from worker_control import FORMAT, JobError, WorkerControl, atomic_json, job_identity, process_identity


def fake_child():
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    count = 0
    print(json.dumps({"event": "ready", "pid": os.getpid()}), flush=True)
    for line in sys.stdin:
        command = json.loads(line)
        root = Path(command["jobRoot"])
        request = json.loads((root / "request/request.json").read_text())
        count += 1
        mode = request.get("mode", "normal")
        if mode == "crash":
            os._exit(7)
        if mode in {"block", "escaped", "escaped-fork"}:
            def late_write():
                time.sleep(0.8)
                (root / "output/late-thread").write_text("unwanted late output")
            thread = threading.Thread(target=late_write)
            thread.start()
            if mode == "escaped-fork":
                read_fd, write_fd = os.pipe()
                descendant = os.fork()
                if descendant == 0:
                    os.close(read_fd)
                    os.setsid()
                    os.write(write_fd, b"ready")
                    os.close(write_fd)
                    time.sleep(10)
                    (root / "output/late-descendant").write_text("unwanted late output")
                    os._exit(0)
                os.close(write_fd)
                assert os.read(read_fd, 5) == b"ready"
                os.close(read_fd)
            else:
                child = subprocess.Popen([
                    sys.executable, "-c",
                    "import signal,time,pathlib,sys; signal.signal(signal.SIGTERM,signal.SIG_IGN); print('ready',flush=True); time.sleep(.8); pathlib.Path(sys.argv[1]).write_text('unwanted late output')",
                    str(root / "output/late-descendant"),
                ], stdout=subprocess.PIPE, text=True, start_new_session=mode == "escaped")
                assert child.stdout.readline().strip() == "ready"
                descendant = child.pid
            (root / "output/running.json").write_text(json.dumps({"pid": os.getpid(), "descendant": descendant}))
            thread.join()
            if mode == "escaped-fork":
                os.waitpid(descendant, 0)
            else:
                child.wait()
        elif mode == "delay":
            time.sleep(0.15)
        result = {"format": "dkb.llamaindex.compile.v2", "compiler": {}, "records": [],
                  "execution": {"pid": os.getpid(), "warmCount": count}}
        (root / "output/llamaindex-compiled.json").write_text(json.dumps(result))
        print(json.dumps({"event": "finished", "jobId": command["jobId"], "ok": True}), flush=True)


def parser_child():
    """Exercise the real child runner with a stdlib-only parser stand-in."""
    compiler = types.ModuleType("compile")
    compiler.MODEL, compiler.MODEL_REVISION = "test", "a" * 40
    compiler.count = 0
    compiler.configure_evidence = lambda options: None

    async def main_async():
        compiler.count += 1
        def background_write():
            time.sleep(0.15)
            compiler.OUTPUT.with_name("executor-drained").write_text("finished")
        asyncio.create_task(asyncio.to_thread(background_write))
        await asyncio.sleep(0.03)
        request = json.loads(compiler.REQUEST.read_text())
        if request.get("mode") == "failure":
            raise ValueError("isolated parser failure")
        compiler.OUTPUT.write_text(json.dumps({
            "format": "dkb.llamaindex.compile.v2", "records": [],
            "execution": {"pid": os.getpid(), "warmCount": compiler.count},
        }))

    compiler.main_async = main_async
    sys.modules["compile"] = compiler
    from worker import main
    main()


class WorkerControlTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="dkb-worker-control-test-")
        self.root = Path(self.temporary.name)
        self.control = self.new_control()
        await self.control.start()

    def new_control(self):
        return WorkerControl(self.root, worker_command=[sys.executable, __file__, "--fake-child"], terminate_grace=0.05)

    async def asyncTearDown(self):
        await self.control.close()
        self.temporary.cleanup()

    def payload(self, name, mode="normal", seconds=15):
        (self.root / name / "input").mkdir(parents=True, exist_ok=True)
        return {"jobId": name, "jobToken": secrets.token_urlsafe(32),
                "deadline": datetime.fromtimestamp(time.time() + seconds, timezone.utc).isoformat(),
                "request": {"mode": mode}, "model": "test", "modelRevision": "a" * 40,
                "evidenceOptions": {}, "workers": 1}

    async def running(self, name):
        marker = self.root / name / "output/running.json"
        deadline = time.monotonic() + 3
        while not marker.exists():
            self.assertLess(time.monotonic(), deadline)
            await asyncio.sleep(0.01)
        return json.loads(marker.read_text())

    async def terminal(self, payload):
        deadline = time.monotonic() + 5
        while True:
            result = await self.control.status(payload["jobId"], payload["jobToken"])
            if result["safeToCleanup"]:
                return result
            self.assertLess(time.monotonic(), deadline)
            await asyncio.sleep(0.01)

    async def assert_compile_error(self, task, code):
        with self.assertRaises(JobError) as caught:
            await task
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    async def test_success_reuses_warm_child_and_late_cancel_does_not_kill_it(self):
        first_payload, second_payload = self.payload("first"), self.payload("second")
        first = await self.control.compile(first_payload)
        second = await self.control.compile(second_payload)
        self.assertEqual(first["execution"]["pid"], second["execution"]["pid"])
        self.assertEqual([first["execution"]["warmCount"], second["execution"]["warmCount"]], [1, 2])
        self.assertTrue(second["job"]["safeToCleanup"])
        self.assertFalse(second["job"]["terminated"])
        late = await self.control.cancel(first_payload["jobId"], first_payload["jobToken"])
        self.assertEqual(late["status"], "completed")
        self.assertIsNotNone(process_identity(second["execution"]["pid"]))

    async def cancellation_case(self, mode):
        payload = self.payload("active", mode)
        task = asyncio.create_task(self.control.compile(payload))
        running = await self.running("active")
        accepted = await self.control.cancel(payload["jobId"], payload["jobToken"])
        self.assertEqual(accepted["status"], "cancelling")
        self.assertFalse(accepted["safeToCleanup"])
        error = await self.assert_compile_error(task, "compile_cancelled")
        self.assertTrue(error.job["terminated"])
        self.assertTrue(error.job["safeToCleanup"])
        self.assertIsNone(process_identity(running["pid"]))
        self.assertIsNone(process_identity(running["descendant"]))
        await asyncio.sleep(0.9)
        self.assertFalse((self.root / "active/output/late-thread").exists())
        self.assertFalse((self.root / "active/output/late-descendant").exists())
        next_result = await self.control.compile(self.payload("next"))
        self.assertNotEqual(next_result["execution"]["pid"], running["pid"])
        self.assertEqual(next_result["execution"]["warmCount"], 1)

    async def test_hard_cancel_reaps_threads_and_descendants_before_ack(self):
        await self.cancellation_case("block")

    async def test_hard_cancel_reaps_descendant_that_started_another_session(self):
        await self.cancellation_case("escaped")

    async def test_hard_cancel_reaps_forked_descendant_retaining_control_pipe(self):
        await self.cancellation_case("escaped-fork")

    async def test_cancel_before_start_is_durable_and_never_dispatches(self):
        payload = self.payload("late")
        result = await self.control.cancel(payload["jobId"], payload["jobToken"])
        self.assertEqual(result["status"], "cancelled")
        self.assertTrue(result["safeToCleanup"])
        await self.control.close()
        self.control = self.new_control()
        await self.control.start()
        await self.assert_compile_error(self.control.compile(payload), "compile_cancelled")
        self.assertIsNone(self.control.child)
        self.assertFalse((self.root / "late/request").exists())

    async def test_queued_cancel_does_not_kill_the_active_job(self):
        active = self.payload("active", "block")
        active_task = asyncio.create_task(self.control.compile(active))
        running = await self.running("active")
        queued = self.payload("queued")
        queued_task = asyncio.create_task(self.control.compile(queued))
        await asyncio.sleep(0.02)
        cancelled = await self.control.cancel(queued["jobId"], queued["jobToken"])
        self.assertTrue(cancelled["terminated"])
        self.assertIsNotNone(process_identity(running["pid"]))
        await self.assert_compile_error(queued_task, "compile_cancelled")
        await self.control.cancel(active["jobId"], active["jobToken"])
        await self.assert_compile_error(active_task, "compile_cancelled")

    async def test_duplicate_request_attaches_and_drift_or_wrong_token_cannot_mutate_it(self):
        payload = self.payload("shared", "delay")
        first = asyncio.create_task(self.control.compile(payload))
        await asyncio.sleep(0.02)
        second = asyncio.create_task(self.control.compile(payload))
        with self.assertRaises(JobError) as drift:
            await self.control.compile({**payload, "request": {"mode": "normal"}})
        self.assertEqual(drift.exception.code, "job_conflict")
        with self.assertRaises(JobError) as wrong:
            await self.control.cancel(payload["jobId"], "x" * 43)
        self.assertEqual(wrong.exception.http_status, 403)
        results = await asyncio.gather(first, second)
        self.assertEqual([item["execution"]["warmCount"] for item in results], [1, 1])
        self.assertNotIn(payload["jobToken"], self.control.record_path(payload["jobId"]).read_text())

    async def test_disconnected_caller_does_not_abandon_worker_ownership(self):
        payload = self.payload("disconnect", "block")
        caller = asyncio.create_task(self.control.compile(payload))
        await self.running(payload["jobId"])
        caller.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await caller
        self.assertEqual((await self.control.status(payload["jobId"], payload["jobToken"]))["status"], "running")
        await self.control.cancel(payload["jobId"], payload["jobToken"])
        self.assertTrue((await self.terminal(payload))["terminated"])

    async def test_hard_deadline_terminates_running_work(self):
        payload = self.payload("deadline", "block", seconds=0.2)
        error = await self.assert_compile_error(self.control.compile(payload), "compile_cancelled")
        self.assertEqual(error.job["reason"], "deadline_expired")
        self.assertTrue(error.job["terminated"])

    async def test_child_crash_is_reaped_then_replaced(self):
        payload = self.payload("crash", "crash")
        error = await self.assert_compile_error(self.control.compile(payload), "compile_failed")
        self.assertTrue(error.job["safeToCleanup"])
        self.assertTrue(error.job["terminated"])
        result = await self.control.compile(self.payload("after-crash"))
        self.assertEqual(result["execution"]["warmCount"], 1)

    async def test_failed_termination_stays_unconfirmed_and_can_be_retried(self):
        payload = self.payload("unconfirmed", "block")
        task = asyncio.create_task(self.control.compile(payload))
        await self.running(payload["jobId"])
        stop_group = self.control.stop_group
        async def unavailable(child):
            raise RuntimeError("isolated termination failure")
        self.control.stop_group = unavailable
        await self.control.cancel(payload["jobId"], payload["jobToken"])
        error = await self.assert_compile_error(task, "compile_termination_unconfirmed")
        self.assertFalse(error.job["safeToCleanup"])
        self.assertTrue(self.control.record_path(payload["jobId"]).exists())
        self.control.stop_group = stop_group
        await self.control.cancel(payload["jobId"], payload["jobToken"])
        self.assertTrue((await self.terminal(payload))["terminated"])

    async def test_previously_queued_job_never_reuses_unconfirmed_worker(self):
        active, queued = self.payload("unconfirmed", "block"), self.payload("queued")
        active_task = asyncio.create_task(self.control.compile(active))
        await self.running(active["jobId"])
        queued_task = asyncio.create_task(self.control.compile(queued))
        await asyncio.sleep(0.02)
        stop_group = self.control.stop_group
        async def unavailable(child):
            raise RuntimeError("isolated termination failure")
        self.control.stop_group = unavailable
        try:
            await self.control.cancel(active["jobId"], active["jobToken"])
            await self.assert_compile_error(active_task, "compile_termination_unconfirmed")
            error = await self.assert_compile_error(queued_task, "compile_failed")
            self.assertEqual(error.job["reason"], "worker_unavailable_before_dispatch")
            self.assertTrue(error.job["safeToCleanup"])
            self.assertNotIn("worker", self.control.records[queued["jobId"]])
            self.assertFalse((self.root / "queued/output/llamaindex-compiled.json").exists())
        finally:
            self.control.stop_group = stop_group
            await self.control.cancel(active["jobId"], active["jobToken"])
            await self.terminal(active)

    async def test_real_child_runner_drains_executor_before_success_or_failure_ack(self):
        self.control.worker_command = [sys.executable, __file__, "--parser-child"]
        first = await self.control.compile(self.payload("drain-first"))
        self.assertTrue((self.root / "drain-first/output/executor-drained").exists())
        second = await self.control.compile(self.payload("drain-second"))
        self.assertEqual(first["execution"]["pid"], second["execution"]["pid"])
        self.assertEqual(second["execution"]["warmCount"], 2)
        self.assertEqual(self.control.deadlines, {})
        failure = await self.assert_compile_error(self.control.compile(self.payload("drain-failed", "failure")), "compile_failed")
        self.assertTrue(failure.job["safeToCleanup"])
        self.assertTrue((self.root / "drain-failed/output/executor-drained").exists())

    async def test_http_wire_envelopes_errors_and_validation_never_echo_token(self):
        import service
        async def request(path, payload):
            messages = []
            delivered = False
            async def receive():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": json.dumps(payload).encode(), "more_body": False}
                await asyncio.Event().wait()
            async def send(message):
                messages.append(message)
            scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
                     "method": "POST", "scheme": "http", "path": path, "raw_path": path.encode(),
                     "query_string": b"", "root_path": "", "headers": [(b"content-type", b"application/json")],
                     "client": ("127.0.0.1", 1000), "server": ("127.0.0.1", 8091)}
            await service.app(scope, receive, send)
            return messages[0]["status"], json.loads(b"".join(item.get("body", b"") for item in messages))
        with patch.object(service, "control", self.control):
            invalid = "must-not-reflect-" * 20
            status, error = await request("/jobs/cancel", {"jobId": "invalid", "jobToken": invalid})
            self.assertEqual(status, 422)
            self.assertNotIn(invalid, json.dumps(error))
            payload = self.payload("wire")
            status, result = await request("/compile", payload)
            self.assertEqual(status, 200)
            self.assertEqual(result["format"], "dkb.llamaindex.compile.v2")
            self.assertEqual(result["job"]["jobTokenHash"], job_identity(payload["jobId"], payload["jobToken"]))
            self.assertNotIn(payload["jobToken"], json.dumps(result))
            status, result = await request("/jobs/status", {key: payload[key] for key in ("jobId", "jobToken")})
            self.assertEqual((status, result["status"], result["safeToCleanup"]), (200, "completed", True))
            status, result = await request("/jobs/cancel", {"jobId": payload["jobId"], "jobToken": "x" * 43})
            self.assertEqual(status, 403)
            self.assertNotIn("job", result)

    async def test_restart_reconciles_unresolved_journal_without_inventing_completion(self):
        job_id, token = "prior", secrets.token_urlsafe(32)
        atomic_json(self.control.record_path(job_id), {
            "format": FORMAT, "jobId": job_id, "jobTokenHash": job_identity(job_id, token),
            "status": "cancelling", "safeToCleanup": False, "terminated": False, "updatedAt": time.time(),
        })
        await self.control.close()
        self.control = self.new_control()
        await self.control.start()
        result = await self.control.status(job_id, token)
        self.assertEqual(result["status"], "cancelled")
        self.assertTrue(result["terminated"])
        self.assertEqual(result["reason"], "worker_restarted")

    async def test_identity_and_deadline_bounds_fail_before_dispatch(self):
        payload = self.payload("bounds")
        for altered in [{"jobId": ".."}, {"jobToken": "short"}, {"deadline": "not-a-date"},
                        {"deadline": datetime.fromtimestamp(time.time() + 90000, timezone.utc).isoformat()}]:
            with self.assertRaises(JobError):
                await self.control.compile({**payload, **altered})
        with self.assertRaises(JobError) as unknown:
            await self.control.status("missing", payload["jobToken"])
        self.assertEqual(unknown.exception.code, "job_unknown")
        self.assertIsNone(self.control.child)

    async def test_failed_tombstone_write_cannot_return_cleanup_permission(self):
        token = secrets.token_urlsafe(32)
        with patch("worker_control.atomic_json", side_effect=OSError("isolated storage failure")):
            with self.assertRaises(OSError):
                await self.control.cancel("not-admitted", token)
        with self.assertRaises(JobError) as unknown:
            await self.control.status("not-admitted", token)
        self.assertEqual(unknown.exception.code, "job_unknown")

    async def test_invalid_process_identity_in_journal_fails_closed(self):
        await self.control.close()
        token = secrets.token_urlsafe(32)
        atomic_json(self.control.record_path("invalid"), {
            "format": FORMAT, "jobId": "invalid", "jobTokenHash": job_identity("invalid", token),
            "status": "running", "safeToCleanup": False, "terminated": False, "updatedAt": time.time(),
            "worker": {"pid": -1, "start": "0"},
        })
        self.control = self.new_control()
        with self.assertRaisesRegex(RuntimeError, "Invalid Evidence job journal"):
            await self.control.start()


if __name__ == "__main__":
    if "--fake-child" in sys.argv:
        fake_child()
    elif "--parser-child" in sys.argv:
        parser_child()
    else:
        unittest.main()
