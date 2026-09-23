import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import main


def write_snapshot(root: Path, slug: str, name: str, service: str) -> None:
    directory = root / slug
    directory.mkdir(parents=True)
    (directory / "graph.json").write_text(
        json.dumps({"nodes": [{"id": service, "type": "service"}], "edges": []}),
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
        write_snapshot(root, "deviceas", "DeviceAS", "Waters.DeviceAS.Server")
        write_snapshot(root, "tenancyas", "TenancyAS", "Waters.TenancyAS.Server")
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

    def test_switching_changes_the_graph_and_rejects_unknown_names(self):
        self.assertEqual(self.client.get("/graph").json()["nodes"][0]["id"], "Waters.DeviceAS.Server")
        switched = self.client.post("/snapshots/active", json={"slug": "tenancyas"})
        self.assertEqual(switched.status_code, 200)
        self.assertEqual(switched.json()["current"]["name"], "TenancyAS")
        self.assertEqual(self.client.get("/graph").json()["nodes"][0]["id"], "Waters.TenancyAS.Server")
        for bad in ["missing", "../deviceas", "not-a-snapshot"]:
            self.assertEqual(
                self.client.post("/snapshots/active", json={"slug": bad}).status_code, 404
            )


if __name__ == "__main__":
    unittest.main()
