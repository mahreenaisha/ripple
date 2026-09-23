import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import main
from knowledge import (
    KnowledgeError,
    attach_knowledge,
    facts_for_flow,
    load_knowledge,
    validate_knowledge,
)

KNOWLEDGE_YAML = """
schema_version: 1
facts:
  - id: heartbeat-delay
    kind: doc
    title: Heartbeat notifications wait 2 minutes
    text: NotificationSettings HeartbeatDelay is 00:02:00.
    applies_to:
      triggers: [TenancyDevicesHeartbeat]
    source: {type: doc, path: server/appsettings.json, line: 63}
    verified: false
  - id: tdi
    kind: rule
    title: TDI applies
    text: Document ids must start with the tenant id.
    applies_to:
      boundaries: [OpenSearch]
    source: {type: doc, path: docs/design/opensearch.md, line: 737}
    verified: true
terms:
  TDI: Tenancy data isolation.
"""


def step(kind, symbol, label=None):
    return {
        "kind": kind,
        "symbol": symbol,
        "label": label or symbol,
        "file": "server/Handler.cs",
        "line": 1,
        "confidence": "high",
        "evidence": ["evidence"],
    }


def artifact() -> dict:
    return {
        "schema_version": "1.0.0",
        "flows": [
            {
                "id": "flow-heartbeat",
                "service": "server",
                "trigger": {
                    "kind": "queue",
                    "label": "TenancyDevicesHeartbeat",
                    "message_type": "TenancyDevicesHeartbeat",
                },
                "confidence": "high",
                "steps": [
                    step("queue-trigger", "TenancyDevicesHeartbeat"),
                    step("handler", "TenancyDevicesHeartbeatHandler.HandleMessage"),
                ],
                "story": {
                    "category": "background-job",
                    "summary": "Runs when TenancyAS sends a heartbeat. It runs 8 checks.",
                    "produces": {
                        "metrics": [],
                        "boundaries": [{"kind": "database", "system": "OpenSearch", "access": "check"}],
                    },
                },
            },
            {
                "id": "flow-health",
                "service": "server",
                "trigger": {"kind": "api", "label": "GET /health"},
                "confidence": "high",
                "steps": [step("api-trigger", "GET /health"), step("handler", "Health.Get")],
            },
        ],
        "glossary": {"flow": "One path."},
    }


class KnowledgeModuleTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "knowledge.yaml"
        self.path.write_text(KNOWLEDGE_YAML, encoding="utf-8")

    def tearDown(self):
        self.directory.cleanup()

    def test_matches_facts_by_trigger_and_story_boundary_with_rules_first(self):
        knowledge = load_knowledge(self.path)
        facts = facts_for_flow(knowledge, artifact()["flows"][0])
        self.assertEqual([fact["id"] for fact in facts], ["tdi", "heartbeat-delay"])
        self.assertEqual(facts[0]["matched_by"], "touches OpenSearch")
        self.assertEqual(facts[1]["matched_by"], "trigger TenancyDevicesHeartbeat")
        self.assertEqual(facts_for_flow(knowledge, artifact()["flows"][1]), [])

    def test_attach_merges_terms_without_mutating_the_input(self):
        original = artifact()
        enriched = attach_knowledge(original, load_knowledge(self.path))
        self.assertNotIn("knowledge", original["flows"][0])
        self.assertEqual(len(enriched["flows"][0]["knowledge"]), 2)
        self.assertEqual(enriched["glossary"]["TDI"], "Tenancy data isolation.")
        self.assertEqual(enriched["glossary"]["flow"], "One path.")

    def test_missing_file_is_empty_and_bad_facts_are_rejected(self):
        empty = load_knowledge(Path(self.directory.name) / "absent.yaml")
        self.assertEqual(empty["facts"], [])
        with self.assertRaises(KnowledgeError):
            validate_knowledge({
                "schema_version": 1,
                "facts": [{
                    "id": "x", "kind": "tribal", "title": "t", "text": "t",
                    "applies_to": {}, "source": {"type": "person"}, "verified": False,
                }],
            })

    def test_checked_in_deviceas_knowledge_is_valid(self):
        knowledge = load_knowledge(main.DEFAULT_KNOWLEDGE)
        ids = {fact["id"] for fact in knowledge["facts"]}
        self.assertEqual(ids, {"heartbeat-purpose", "tenancy-data-isolation"})
        self.assertTrue(all(fact["source"]["type"] != "person" for fact in knowledge["facts"]))
        self.assertIn("Scalars Access", knowledge["terms"])


class KnowledgeApiTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        flows_path = Path(self.directory.name) / "request-flows.json"
        flows_path.write_text(json.dumps(artifact()), encoding="utf-8")
        knowledge_path = Path(self.directory.name) / "knowledge.yaml"
        knowledge_path.write_text(KNOWLEDGE_YAML, encoding="utf-8")
        self.environment = patch.dict(
            os.environ,
            {
                "REQUEST_FLOWS_PATH": str(flows_path),
                "KNOWLEDGE_PATH": str(knowledge_path),
                "LLM_PROVIDER": "openrouter",
                "OPENROUTER_API_KEY": "",
            },
        )
        self.environment.start()
        self.client = TestClient(main.app)

    def tearDown(self):
        self.environment.stop()
        self.directory.cleanup()

    def test_flow_api_serves_attached_facts(self):
        flow = self.client.get("/request-flows/flow-heartbeat").json()
        self.assertEqual([fact["id"] for fact in flow["knowledge"]], ["tdi", "heartbeat-delay"])
        self.assertEqual(self.client.get("/knowledge").json()["terms"]["TDI"], "Tenancy data isolation.")

    def test_offline_flow_answer_uses_story_and_names_unverified_source(self):
        response = self.client.post(
            "/chat",
            json={
                "message": "Why does this exist?",
                "context": {"type": "flow", "flow_id": "flow-heartbeat"},
            },
        )
        body = response.json()
        self.assertEqual(body["mode"], "offline")
        self.assertIn("Runs when TenancyAS sends a heartbeat", body["response"])
        self.assertIn("server/appsettings.json:63, not yet verified", body["response"])

    def test_add_fact_checks_the_file_and_attaches_to_the_flow(self):
        repo = Path(self.directory.name) / "repo"
        (repo / "docs").mkdir(parents=True)
        (repo / "docs" / "health.md").write_text("# Health\nHealth checks skip auth.\n", encoding="utf-8")
        (Path(self.directory.name) / "secret.txt").write_text("outside", encoding="utf-8")
        with patch.dict(os.environ, {"RIPPLE_REPO_PATH": str(repo)}):
            checked = self.client.get("/repo-file", params={"path": "docs/health.md", "line": 2}).json()
            self.assertEqual(checked["excerpt"], "Health checks skip auth.")
            self.assertEqual(self.client.get("/repo-file", params={"path": "../secret.txt"}).status_code, 400)
            self.assertEqual(self.client.get("/repo-file", params={"path": "docs/health.md", "line": 9}).status_code, 400)

            bad = self.client.post("/knowledge/facts", json={
                "title": "Health skips auth", "text": "No token needed.", "path": "docs/missing.md",
                "triggers": ["GET /health"],
            })
            self.assertEqual(bad.status_code, 400)
            saved = self.client.post("/knowledge/facts", json={
                "title": "Health skips auth", "text": "No token needed.", "kind": "rule",
                "path": "docs/health.md", "line": 2, "triggers": ["GET /health"],
            }).json()

        self.assertEqual(saved["id"], "health-skips-auth")
        self.assertEqual(saved["source"], {"type": "doc", "path": "docs/health.md", "line": 2})
        flow = self.client.get("/request-flows/flow-health").json()
        self.assertEqual([fact["id"] for fact in flow["knowledge"]], ["health-skips-auth"])
        self.assertTrue(Path(os.environ["KNOWLEDGE_PATH"]).read_text().startswith("schema_version"))

    def test_flow_prompt_carries_story_and_team_knowledge(self):
        flows = main._load_request_flows()
        prompt = main._flow_chat_prompt(main.ChatContext(type="flow", flow_id="flow-heartbeat"), flows)
        self.assertIn('"team_knowledge"', prompt)
        self.assertIn("server/appsettings.json:63", prompt)
        self.assertIn("It runs 8 checks", prompt)


if __name__ == "__main__":
    unittest.main()
