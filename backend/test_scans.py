import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

import main
from scans import ScanError, ScanJob, ScanManager


def wait_for_terminal(manager: ScanManager, job_id: str) -> dict:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        status = manager.status(job_id)
        if status["phase"] in {"complete", "failed", "cancelled"}:
            return status
        time.sleep(0.01)
    raise AssertionError("scan job did not finish")


class ScanManagerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.ripple = self.root / "ripple"
        self.snapshots = self.ripple / "snapshots"
        self.repository = self.root / "orders"
        self.ripple.mkdir()
        self.repository.mkdir()
        (self.repository / "Orders.sln").write_text("", encoding="utf-8")
        (self.repository / "nuget.config").write_text("<configuration />", encoding="utf-8")
        self.promoted = threading.Event()
        self.manager = ScanManager(
            self.ripple,
            self.snapshots,
            lambda _slug: self.promoted.set(),
        )
        self.dotnet = patch.object(
            self.manager, "_dotnet", return_value=("/usr/bin/dotnet", "10.0.403")
        )
        self.dotnet.start()

    def tearDown(self):
        self.dotnet.stop()
        self.temporary.cleanup()

    def test_preflight_requires_an_absolute_path_and_detects_restore_inputs(self):
        with self.assertRaisesRegex(ScanError, "must be absolute"):
            self.manager.preflight("orders")

        result = self.manager.preflight(str(self.repository))

        self.assertEqual(result["solutions"], ["Orders.sln"])
        self.assertEqual(result["nuget_config"], "nuget.config")
        self.assertEqual(result["dotnet"]["version"], "10.0.403")
        self.assertEqual(result["slug"], "orders")

    def test_solution_must_stay_inside_the_repository(self):
        outside = self.root / "outside.sln"
        outside.write_text("", encoding="utf-8")
        with self.assertRaisesRegex(ScanError, "escapes"):
            self.manager._selected_solution(
                self.repository,
                "../outside.sln",
                ["Orders.sln"],
                True,
            )

    def test_restore_can_be_disabled_when_no_solution_exists(self):
        (self.repository / "Orders.sln").unlink()
        self.assertIsNone(
            self.manager._selected_solution(self.repository, None, [], False)
        )
        with self.assertRaisesRegex(ScanError, "no .sln"):
            self.manager._selected_solution(self.repository, None, [], True)

    def test_successful_job_restores_scans_promotes_and_preserves_contract(self):
        previous = self.snapshots / "orders"
        previous.mkdir(parents=True)
        (previous / "request-flows.json").write_text('{"old": true}', encoding="utf-8")
        commands: list[list[str]] = []

        def fake_run(_job, command, _cwd):
            commands.append(command)
            if "scan-repo.js" not in " ".join(command):
                return
            output = Path(command[command.index("--out") + 1])
            output.mkdir(parents=True)
            (output / "request-flows.json").write_text(
                json.dumps(
                    {
                        "schema_version": "1.0.0",
                        "flows": [],
                        "warnings": [],
                        "glossary": {},
                    }
                ),
                encoding="utf-8",
            )
            (output / "snapshot.json").write_text(
                json.dumps({"name": "Orders", "counts": {"flows": 0}}),
                encoding="utf-8",
            )

        with patch.object(self.manager, "_run_command", side_effect=fake_run):
            started = self.manager.start(
                str(self.repository), "Orders", "Orders.sln", True
            )
            status = wait_for_terminal(self.manager, started["id"])

        self.assertEqual(status["phase"], "complete")
        self.assertTrue(self.promoted.is_set())
        self.assertIn("--configfile", commands[0])
        self.assertTrue(
            json.loads(
                (self.snapshots / "orders" / "request-flows.json").read_text(
                    encoding="utf-8"
                )
            )["flows"]
            == []
        )

    def test_project_load_failures_do_not_replace_previous_snapshot(self):
        previous = self.snapshots / "orders"
        previous.mkdir(parents=True)
        old = '{"old": true}'
        (previous / "request-flows.json").write_text(old, encoding="utf-8")

        def fake_run(_job, command, _cwd):
            if "scan-repo.js" not in " ".join(command):
                return
            output = Path(command[command.index("--out") + 1])
            output.mkdir(parents=True)
            (output / "request-flows.json").write_text(
                json.dumps(
                    {
                        "flows": [],
                        "warnings": [
                            {"code": "project-load-failed", "message": "private SDK missing"}
                        ],
                    }
                ),
                encoding="utf-8",
            )
            (output / "snapshot.json").write_text(
                json.dumps({"counts": {"flows": 0}}), encoding="utf-8"
            )

        with patch.object(self.manager, "_run_command", side_effect=fake_run):
            started = self.manager.start(
                str(self.repository), "Orders", "Orders.sln", False
            )
            status = wait_for_terminal(self.manager, started["id"])

        self.assertEqual(status["phase"], "failed")
        self.assertIn("previous snapshot was preserved", status["error"])
        self.assertEqual(
            (previous / "request-flows.json").read_text(encoding="utf-8"), old
        )

    def test_restore_errors_are_visible_and_scan_is_not_started(self):
        commands = []

        def fail_restore(_job, command, _cwd):
            commands.append(command)
            raise ScanError("dotnet exited with status 1. Private feed authentication failed.")

        with patch.object(self.manager, "_run_command", side_effect=fail_restore):
            started = self.manager.start(
                str(self.repository), "Orders", "Orders.sln", True
            )
            status = wait_for_terminal(self.manager, started["id"])

        self.assertEqual(status["phase"], "failed")
        self.assertIn("authentication", status["error"])
        self.assertEqual(len(commands), 1)

    def test_cancellation_terminates_the_active_process(self):
        process = Mock()
        process.poll.return_value = None
        job = ScanJob(
            id="job-1",
            repo_path=self.repository,
            name="Orders",
            slug="orders",
            solution=self.repository / "Orders.sln",
            restore_packages=True,
            phase="scanning",
            process=process,
        )
        self.manager._jobs[job.id] = job

        status = self.manager.cancel(job.id)

        self.assertEqual(status["phase"], "cancelling")
        process.terminate.assert_called_once()


class ScanApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)

    def test_scan_api_maps_manager_errors_and_accepts_jobs(self):
        manager = Mock()
        manager.preflight.return_value = {"repo_path": "/code/orders"}
        manager.start.return_value = {"id": "job-1", "phase": "validating"}
        manager.status.side_effect = ScanError("missing", 404)

        with patch.object(main, "scan_manager", manager):
            preflight = self.client.post(
                "/scans/preflight", json={"repo_path": "/code/orders"}
            )
            started = self.client.post(
                "/scans",
                json={
                    "repo_path": "/code/orders",
                    "restore_packages": False,
                },
            )
            missing = self.client.get("/scans/missing")

        self.assertEqual(preflight.status_code, 200)
        self.assertEqual(started.status_code, 202)
        self.assertEqual(missing.status_code, 404)
        manager.start.assert_called_once_with(
            "/code/orders", None, None, False
        )

    def test_cors_allows_local_ui_and_rejects_other_origins(self):
        local = self.client.options(
            "/scans/preflight",
            headers={
                "Origin": "http://localhost:4200",
                "Access-Control-Request-Method": "POST",
            },
        )
        other = self.client.options(
            "/scans/preflight",
            headers={
                "Origin": "https://example.com",
                "Access-Control-Request-Method": "POST",
            },
        )

        self.assertEqual(local.headers.get("access-control-allow-origin"), "http://localhost:4200")
        self.assertNotIn("access-control-allow-origin", other.headers)


if __name__ == "__main__":
    unittest.main()
