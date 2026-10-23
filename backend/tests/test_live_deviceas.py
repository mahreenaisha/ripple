from __future__ import annotations

import os
from datetime import UTC, datetime
from pathlib import Path

import pytest

from backend.models import RepositoryRecord
from backend.repository import RepositoryAnalyzer

DEVICEAS_PATH = Path(
    os.getenv("RIPPLE_DEVICEAS_PATH", str(Path.home() / "repos" / "wcc-deviceas"))
).expanduser()


@pytest.mark.skipif(not DEVICEAS_PATH.exists(), reason="Live DeviceAS repository is not mounted")
def test_live_deviceas_structural_contract() -> None:
    repository = RepositoryRecord(
        id="live-deviceas",
        name="DeviceAS",
        path=str(DEVICEAS_PATH.resolve()),
        added_at=datetime.now(UTC),
    )
    analyzer = RepositoryAnalyzer()
    inventory = analyzer.inventory(repository)
    root_paths = {entry.path.casefold() for entry in inventory.entries}

    assert {"server", "utilities", "infrastructure"} <= root_paths
    assert all(entry.path != ".git" and not entry.path.startswith(".git/") for entry in inventory.entries)
    for folder in ("server", "utilities", "infrastructure"):
        analysis = analyzer.analyze_folder(repository, folder)
        assert analysis.facts.file_count > 0
        assert analysis.facts.state_hash
        assert all(".env" not in item.file.casefold() for item in analysis.evidence)

