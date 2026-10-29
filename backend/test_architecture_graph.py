import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import main
from architecture_graph import ArchitectureGraphError, validate_architecture_graph


def graph_fixture() -> dict:
    return {
        "schema_version": "1.0.0",
        "generator": {"strategy": "roslyn-source-study"},
        "analysis": {"mode": "study", "completeness": "partial"},
        "nodes": [
            {
                "id": "service-orders",
                "kind": "service",
                "label": "Orders",
                "confidence": "high",
                "resolution": "direct",
                "flow_ids": ["flow-orders"],
                "source": {
                    "file": "src/Orders/Program.cs",
                    "line": 1,
                    "symbol": "Orders",
                },
            },
            {
                "id": "database-orders",
                "kind": "database",
                "label": "Orders database",
                "confidence": "medium",
                "resolution": "inferred",
                "flow_ids": ["flow-orders"],
                "source": None,
            },
        ],
        "edges": [
            {
                "id": "edge-orders",
                "source": "service-orders",
                "target": "database-orders",
                "kind": "queries",
                "confidence": "medium",
                "resolution": "inferred",
                "flow_ids": ["flow-orders"],
                "evidence": [
                    {
                        "file": "src/Orders/Repository.cs",
                        "line": 12,
                        "symbol": "OrderRepository.Save",
                        "reason": "Request flow reaches a database boundary.",
                        "confidence": "medium",
                        "resolution": "inferred",
                    }
                ],
            }
        ],
        "warnings": [],
    }


class ArchitectureGraphTests(unittest.TestCase):
    def test_validates_evidence_backed_graph(self):
        self.assertEqual(
            validate_architecture_graph(graph_fixture())["edges"][0]["kind"],
            "queries",
        )

    def test_rejects_dangling_edges_and_escaping_paths(self):
        dangling = graph_fixture()
        dangling["edges"][0]["target"] = "missing"
        with self.assertRaisesRegex(ArchitectureGraphError, "missing node"):
            validate_architecture_graph(dangling)

        escaping = graph_fixture()
        escaping["edges"][0]["evidence"][0]["file"] = "../secret.cs"
        with self.assertRaisesRegex(ArchitectureGraphError, "repository-relative"):
            validate_architecture_graph(escaping)

    def test_serves_active_snapshot_graph(self):
        with tempfile.TemporaryDirectory() as directory:
            snapshot = Path(directory) / "orders"
            snapshot.mkdir()
            (snapshot / "request-flows.json").write_text("{}", encoding="utf-8")
            (snapshot / "snapshot.json").write_text(
                json.dumps({"name": "Orders"}), encoding="utf-8"
            )
            (snapshot / "architecture-graph.json").write_text(
                json.dumps(graph_fixture()), encoding="utf-8"
            )
            with patch.dict(
                os.environ,
                {
                    "RIPPLE_SNAPSHOTS_DIR": directory,
                    "RIPPLE_SNAPSHOT": "orders",
                },
            ):
                main._active_snapshot = None
                response = TestClient(main.app).get("/architecture-graph")
                main._active_snapshot = None

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["nodes"][0]["id"], "service-orders")


if __name__ == "__main__":
    unittest.main()
