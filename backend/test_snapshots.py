import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import main


def write_snapshot(root: Path, slug: str, name: str) -> None:
    directory = root / slug
    directory.mkdir(parents=True)
    (directory / "request-flows.json").write_text(
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
    (directory / "snapshot.json").write_text(
        json.dumps(
            {
                "name": name,
                "source": {"commit": "abc1234def", "branch": "main", "scannedAt": "2026-09-23T08:00:00Z"},
                "counts": {"flows": 3},
            }
        ),
        encoding="utf-8",
    )


class SnapshotApiTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        write_snapshot(root, "deviceas", "DeviceAS")
        write_snapshot(root, "tenancyas", "TenancyAS")
        (root / "not-a-snapshot").mkdir()
        self.environment = patch.dict(
            os.environ,
            {"RIPPLE_SNAPSHOTS_DIR": str(root), "RIPPLE_SNAPSHOT": "deviceas"},
        )
        self.environment.start()
        main._active_snapshot = None
        self.client = TestClient(main.app)

    def tearDown(self):
        main._active_snapshot = None
        self.environment.stop()
        self.directory.cleanup()

    def test_lists_scanned_snapshots_with_freshness(self):
        body = self.client.get("/snapshots").json()
        self.assertEqual(body["active"], "deviceas")
        self.assertEqual([item["slug"] for item in body["snapshots"]], ["deviceas", "tenancyas"])
        self.assertEqual(body["current"]["name"], "DeviceAS")
        self.assertEqual(body["current"]["source"]["commit"], "abc1234def")
        self.assertEqual(
            body["current"]["capabilities"]["map"]["status"],
            "missing",
        )

    def test_switching_changes_the_active_snapshot_and_rejects_unknown_names(self):
        switched = self.client.post("/snapshots/active", json={"slug": "tenancyas"})
        self.assertEqual(switched.status_code, 200)
        self.assertEqual(switched.json()["current"]["name"], "TenancyAS")
        for bad in ["missing", "../deviceas", "not-a-snapshot"]:
            self.assertEqual(
                self.client.post("/snapshots/active", json={"slug": bad}).status_code, 404
            )

    def test_accepts_a_request_flow_only_snapshot(self):
        root = Path(self.directory.name)
        focused = root / "orders"
        focused.mkdir()
        (focused / "request-flows.json").write_text(
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
        (focused / "snapshot.json").write_text(
            json.dumps({"name": "Orders", "counts": {"flows": 0}}),
            encoding="utf-8",
        )

        listed = self.client.get("/snapshots").json()["snapshots"]
        self.assertIn("orders", [snapshot["slug"] for snapshot in listed])
        self.assertEqual(
            self.client.post("/snapshots/active", json={"slug": "orders"}).status_code,
            200,
        )


if __name__ == "__main__":
    unittest.main()
