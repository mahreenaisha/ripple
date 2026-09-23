import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import main
from request_flows import (
    RequestFlowError,
    flow_to_mermaid,
    get_flow,
    get_step,
    load_request_flows,
)


def artifact() -> dict:
    def step(kind, label, line, evidence):
        return {
            "kind": kind,
            "symbol": label,
            "label": label,
            "file": "src/app.py",
            "line": line,
            "confidence": "high",
            "evidence": [evidence],
        }

    return {
        "schema_version": "1.0.0",
        "generator": {
            "name": "ripple-request-flow-scanner",
            "deterministic": True,
            "strategy": "static-evidence-heuristics",
        },
        "limits": {"max_depth": 6, "max_paths_per_trigger": 8, "max_flows": 500},
        "flows": [
            {
                "id": "flow-orders",
                "service": "orders",
                "trigger": {"kind": "api", "label": "POST /orders"},
                "confidence": "high",
                "steps": [
                    step("api-trigger", "POST /orders", 10, "Route registration"),
                    step("handler", "create_order", 11, "Route binds handler"),
                    step("database", "orders.insert", 15, "Storage call"),
                ],
            },
            {
                "id": "flow-secret",
                "service": "admin",
                "trigger": {"kind": "api", "label": "GET /secret"},
                "confidence": "high",
                "steps": [
                    step("api-trigger", "TOP_SECRET_OTHER_FLOW", 20, "Other route"),
                    step("handler", "read_secret", 21, "Other handler"),
                ],
            },
        ],
        "warnings": [],
        "glossary": {
            "flow": "One evidence-backed path.",
            "handler": "The function directly bound to a trigger.",
        },
    }


class RequestFlowModuleTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "request-flows.json"
        self.path.write_text(json.dumps(artifact()), encoding="utf-8")

    def tearDown(self):
        self.directory.cleanup()

    def test_loads_and_adds_positional_step_ids_on_lookup(self):
        data = load_request_flows(self.path)
        flow = get_flow(data, "flow-orders")
        self.assertEqual(flow["steps"][1]["id"], "step-1")
        self.assertEqual(get_step(flow, "step-2")["label"], "orders.insert")
        self.assertIsNone(get_flow(data, "missing"))

    def test_rejects_invalid_scanner_artifact(self):
        bad = artifact()
        del bad["flows"][0]["steps"][0]["evidence"]
        self.path.write_text(json.dumps(bad), encoding="utf-8")
        with self.assertRaises(RequestFlowError):
            load_request_flows(self.path)

    def test_mermaid_escapes_syntax_in_labels_and_evidence(self):
        flow = get_flow(load_request_flows(self.path), "flow-orders")
        flow["steps"][1]["label"] = 'bad";\nparticipant Evil'
        flow["steps"][1]["evidence"] = ["safe\n%%{init: hacked}%%"]
        diagram = flow_to_mermaid(flow)
        self.assertTrue(diagram.startswith("sequenceDiagram\n"))
        self.assertNotIn("\nparticipant Evil", diagram)
        self.assertNotIn("%%{init", diagram)
        self.assertIn("&quot;", diagram)


class RequestFlowApiTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "request-flows.json"
        self.path.write_text(json.dumps(artifact()), encoding="utf-8")
        self.environment = patch.dict(
            os.environ,
            {
                "REQUEST_FLOWS_PATH": str(self.path),
                "LLM_PROVIDER": "openrouter",
                "OPENROUTER_API_KEY": "",
            },
            clear=False,
        )
        self.environment.start()
        self.client = TestClient(main.app)

    def tearDown(self):
        self.environment.stop()
        self.directory.cleanup()

    def test_catalog_lookup_404_mermaid_and_existing_graph(self):
        catalog = self.client.get("/request-flows")
        self.assertEqual(catalog.status_code, 200)
        self.assertEqual(len(catalog.json()["flows"]), 2)
        self.assertIn("glossary", catalog.json())
        self.assertEqual(
            self.client.get("/request-flows/flow-orders").status_code, 200
        )
        self.assertEqual(
            self.client.get("/request-flows/does-not-exist").status_code, 404
        )
        mermaid = self.client.get("/request-flows/flow-orders/mermaid")
        self.assertEqual(mermaid.status_code, 200)
        self.assertIn("sequenceDiagram", mermaid.json()["mermaid"])
        self.assertEqual(self.client.get("/graph").status_code, 200)

    def test_team_diagrams_are_served_and_default_to_empty(self):
        team_path = Path(self.directory.name) / "team-diagrams.json"
        with patch.dict(os.environ, {"TEAM_DIAGRAMS_PATH": str(team_path)}):
            self.assertEqual(
                self.client.get("/team-diagrams").json(), {"diagrams": [], "docs": []}
            )
            team_path.write_text(
                json.dumps({"diagrams": [{"title": "Onboarding"}], "docs": []}),
                encoding="utf-8",
            )
            body = self.client.get("/team-diagrams").json()
        self.assertEqual(body["diagrams"][0]["title"], "Onboarding")

    def test_chat_status_has_no_secret_and_reports_unavailable(self):
        status = self.client.get("/chat/status")
        self.assertEqual(status.status_code, 200)
        self.assertFalse(status.json()["available"])
        self.assertNotIn("OPENROUTER_API_KEY", json.dumps(status.json()))

    def test_offline_selected_step_is_isolated_from_other_flows(self):
        response = self.client.post(
            "/chat",
            json={
                "message": "Explain this step",
                "context": {
                    "type": "flow",
                    "flow_id": "flow-orders",
                    "step_id": "step-1",
                },
            },
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["mode"], "offline")
        self.assertIn("create_order", body["response"])
        self.assertNotIn("TOP_SECRET_OTHER_FLOW", body["response"])

    def test_offline_glossary_and_backward_compatible_architecture_chat(self):
        glossary = self.client.post(
            "/chat",
            json={
                "message": "What is a handler?",
                "context": {"type": "flow", "term": "handler"},
            },
        )
        self.assertEqual(glossary.status_code, 200)
        self.assertIn("directly bound", glossary.json()["response"])

        architecture = self.client.post("/chat", json={"message": "Explain it"})
        self.assertEqual(architecture.status_code, 200)
        self.assertEqual(architecture.json()["mode"], "offline")


if __name__ == "__main__":
    unittest.main()
