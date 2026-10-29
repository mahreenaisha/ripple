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
        "schema_version": "2.0.0",
        "generator": {"strategy": "roslyn-source-study"},
        "analysis": {"mode": "study", "completeness": "partial"},
        "summary": {
            "services": 1,
            "libraries": 1,
            "technologies": 1,
            "call_sites": 1,
            "evidence_items": 3,
        },
        "nodes": [
            {
                "id": "service-orders",
                "kind": "service",
                "label": "Orders",
                "name": "Shop.Orders",
                "service": "Shop.Orders",
                "description": "ASP.NET web project",
                "confidence": "high",
                "resolution": "direct",
                "flow_ids": ["flow-orders"],
                "source": {
                    "file": "src/Orders/Program.cs",
                    "line": 1,
                    "symbol": "Shop.Orders",
                },
            },
            {
                "id": "library-data",
                "kind": "library",
                "label": "Data",
                "name": "Shop.Data",
                "service": None,
                "description": "Class library referenced by other projects",
                "confidence": "high",
                "resolution": "direct",
                "flow_ids": [],
                "source": None,
            },
            {
                "id": "database-dynamodb",
                "kind": "database",
                "label": "Amazon DynamoDB",
                "name": "Amazon DynamoDB",
                "service": None,
                "description": "Key-value and document tables",
                "confidence": "high",
                "resolution": "direct",
                "flow_ids": ["flow-orders"],
                "source": None,
            },
        ],
        "edges": [
            {
                "id": "edge-orders",
                "source": "service-orders",
                "target": "database-dynamodb",
                "kind": "queries",
                "strength": "call",
                "confidence": "high",
                "resolution": "direct",
                "evidence_count": 2,
                "flow_ids": ["flow-orders"],
                "evidence": [
                    {
                        "file": "src/Orders/OrderStore.cs",
                        "line": 12,
                        "symbol": "IAmazonDynamoDB.PutItemAsync",
                        "reason": "Calls IAmazonDynamoDB.PutItemAsync",
                        "kind": "call",
                        "confidence": "high",
                        "resolution": "direct",
                    },
                    {
                        "file": "src/Orders/Orders.csproj",
                        "line": 6,
                        "symbol": "AWSSDK.DynamoDBv2",
                        "reason": "References the Amazon DynamoDB SDK package AWSSDK.DynamoDBv2",
                        "kind": "package",
                        "confidence": "medium",
                        "resolution": "direct",
                    },
                ],
            },
            {
                "id": "edge-reference",
                "source": "service-orders",
                "target": "library-data",
                "kind": "references",
                "strength": "declaration",
                "confidence": "high",
                "resolution": "direct",
                "evidence_count": 1,
                "flow_ids": [],
                "evidence": [
                    {
                        "file": "src/Orders/Orders.csproj",
                        "line": 9,
                        "symbol": "Shop.Data",
                        "reason": "Shop.Orders references project Shop.Data",
                        "kind": "project-reference",
                        "confidence": "high",
                        "resolution": "direct",
                    }
                ],
            },
        ],
        "flows": [{"id": "flow-orders", "label": "POST /orders", "service": "Shop.Orders"}],
        "warnings": [],
    }


class ArchitectureGraphTests(unittest.TestCase):
    def test_validates_evidence_backed_graph(self):
        graph = validate_architecture_graph(graph_fixture())
        self.assertEqual([edge["kind"] for edge in graph["edges"]], ["queries", "references"])
        self.assertEqual(graph["summary"]["libraries"], 1)

    def test_rejects_dangling_edges_and_escaping_paths(self):
        dangling = graph_fixture()
        dangling["edges"][0]["target"] = "missing"
        with self.assertRaisesRegex(ArchitectureGraphError, "missing node"):
            validate_architecture_graph(dangling)

        escaping = graph_fixture()
        escaping["edges"][0]["evidence"][0]["file"] = "../secret.cs"
        with self.assertRaisesRegex(ArchitectureGraphError, "repository-relative"):
            validate_architecture_graph(escaping)

    def test_rejects_unknown_strength_evidence_kind_and_short_counts(self):
        strength = graph_fixture()
        strength["edges"][0]["strength"] = "guess"
        with self.assertRaisesRegex(ArchitectureGraphError, "strength is unsupported"):
            validate_architecture_graph(strength)

        kind = graph_fixture()
        kind["edges"][0]["evidence"][0]["kind"] = "flow-boundary"
        with self.assertRaisesRegex(ArchitectureGraphError, "kind is unsupported"):
            validate_architecture_graph(kind)

        count = graph_fixture()
        count["edges"][0]["evidence_count"] = 1
        with self.assertRaisesRegex(ArchitectureGraphError, "evidence_count"):
            validate_architecture_graph(count)

    def test_asks_for_a_rescan_when_the_graph_predates_project_evidence(self):
        legacy = graph_fixture()
        legacy["schema_version"] = "1.0.0"
        with self.assertRaisesRegex(ArchitectureGraphError, "Rescan"):
            validate_architecture_graph(legacy)

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
