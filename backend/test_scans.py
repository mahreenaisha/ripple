import json
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


def write_artifacts(output: Path, analysis: dict) -> None:
    source = {"commit": "abc123", "branch": "main"}
    generator = {"source": source}
    (output / "request-flows.json").write_text(
        json.dumps(
            {
                "schema_version": "1.0.0",
                "generator": generator,
                "analysis": analysis,
                "flows": [],
                "warnings": [{"code": "study-mode-partial"}],
                "glossary": {},
            }
        ),
        encoding="utf-8",
    )
    (output / "architecture-graph.json").write_text(
        json.dumps(
            {
                "schema_version": "2.0.0",
                "generator": generator,
                "analysis": analysis,
                "summary": {
                    "services": 0,
                    "libraries": 0,
                    "technologies": 0,
                    "call_sites": 0,
                    "evidence_items": 0,
                },
                "nodes": [],
                "edges": [],
                "flows": [],
                "warnings": [],
            }
        ),
        encoding="utf-8",
    )
    (output / "snapshot.json").write_text(
        json.dumps(
            {
                "analysis": analysis,
                "source": source,
                "counts": {"flows": 0, "graphNodes": 0, "graphEdges": 0},
            }
        ),
        encoding="utf-8",
    )


class ScanManagerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.ripple = self.root / "ripple"
        self.snapshots = self.ripple / "snapshots"
        self.repository = self.root / "orders"
        self.ripple.mkdir()
        self.repository.mkdir()
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

    def test_preflight_requires_absolute_path_and_checks_dotnet(self):
        with self.assertRaisesRegex(ScanError, "must be absolute"):
            self.manager.preflight("orders")

        result = self.manager.preflight(str(self.repository))

        self.assertEqual(result["dotnet"]["version"], "10.0.403")
        self.assertEqual(result["slug"], "orders")
        self.assertNotIn("solutions", result)
        self.assertNotIn("nuget_config", result)

    def test_source_only_job_scans_and_promotes_partial_artifact(self):
        commands: list[list[str]] = []
        analysis = {
            "mode": "study",
            "completeness": "partial",
            "limitations": ["External package symbols are unavailable."],
        }

        def fake_run(_job, command, _cwd):
            commands.append(command)
            output = Path(command[command.index("--out") + 1])
            output.mkdir(parents=True)
            write_artifacts(output, analysis)

        with patch.object(self.manager, "_run_command", side_effect=fake_run):
            started = self.manager.start(str(self.repository), "Orders")
            status = wait_for_terminal(self.manager, started["id"])

        self.assertEqual(status["phase"], "complete")
        self.assertTrue(self.promoted.is_set())
        self.assertEqual(len(commands), 1)
        self.assertNotIn("--mode", commands[0])
        self.assertNotIn("restore", commands[0])
        self.assertEqual(status["result"]["analysis"]["mode"], "study")

    def test_invalid_artifact_does_not_replace_previous_snapshot(self):
        previous = self.snapshots / "orders"
        previous.mkdir(parents=True)
        old = '{"old": true}'
        (previous / "request-flows.json").write_text(old, encoding="utf-8")

        def fake_run(_job, command, _cwd):
            output = Path(command[command.index("--out") + 1])
            output.mkdir(parents=True)
            analysis = {"mode": "legacy", "completeness": "unknown"}
            write_artifacts(output, analysis)

        with patch.object(self.manager, "_run_command", side_effect=fake_run):
            started = self.manager.start(str(self.repository), "Orders")
            status = wait_for_terminal(self.manager, started["id"])

        self.assertEqual(status["phase"], "failed")
        self.assertIn("source-only study analysis", status["error"])
        self.assertEqual(
            (previous / "request-flows.json").read_text(encoding="utf-8"), old
        )

    def test_rejects_graph_references_to_unavailable_flows(self):
        output = self.root / "output"
        output.mkdir()
        analysis = {"mode": "study", "completeness": "partial"}
        write_artifacts(output, analysis)
        graph_path = output / "architecture-graph.json"
        graph = json.loads(graph_path.read_text(encoding="utf-8"))
        graph["nodes"] = [
            {
                "id": "service-orders",
                "kind": "service",
                "label": "Orders",
                "name": "Orders",
                "confidence": "high",
                "resolution": "direct",
                "flow_ids": ["missing-flow"],
                "source": None,
            }
        ]
        graph_path.write_text(json.dumps(graph), encoding="utf-8")
        snapshot_path = output / "snapshot.json"
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        snapshot["counts"]["graphNodes"] = 1
        snapshot_path.write_text(json.dumps(snapshot), encoding="utf-8")

        with self.assertRaisesRegex(ScanError, "unavailable request flow"):
            self.manager._validate_output(output)

    def test_cancellation_terminates_active_process(self):
        process = Mock()
        process.poll.return_value = None
        job = ScanJob(
            id="job-1",
            repo_path=self.repository,
            name="Orders",
            slug="orders",
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

    def test_scan_api_maps_errors_and_starts_source_only_job(self):
        manager = Mock()
        manager.preflight.return_value = {"repo_path": "/code/orders"}
        manager.start.return_value = {"id": "job-1", "phase": "validating"}
        manager.status.side_effect = ScanError("missing", 404)

        with patch.object(main, "scan_manager", manager):
            preflight = self.client.post(
                "/scans/preflight", json={"repo_path": "/code/orders"}
            )
            started = self.client.post(
                "/scans", json={"repo_path": "/code/orders"}
            )
            missing = self.client.get("/scans/missing")

        self.assertEqual(preflight.status_code, 200)
        self.assertEqual(started.status_code, 202)
        self.assertEqual(missing.status_code, 404)
        manager.start.assert_called_once_with("/code/orders", None)

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

        self.assertEqual(
            local.headers.get("access-control-allow-origin"),
            "http://localhost:4200",
        )
        self.assertNotIn("access-control-allow-origin", other.headers)


if __name__ == "__main__":
    unittest.main()
