from __future__ import annotations

import subprocess
from datetime import UTC, datetime
from pathlib import Path

from fastapi.testclient import TestClient

from explorer import create_app
from explorer_models import (
    EvidenceCitation,
    FolderExplanationContent,
    ModelStatus,
    RepositoryOverviewContent,
    RepositoryRecord,
)
from explorer_ollama import ValidatedExplanation
from explorer_repository import RepositoryAnalyzer


def _deviceas_fixture(tmp_path: Path) -> Path:
    root = tmp_path / "deviceas"
    files = {
        "README.md": "# DeviceAS\n\nRepository purpose.\n\n## Development\n\nRun locally.\n",
        "server/Server.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n',
        "server/Program.cs": "builder.Services.AddControllers();\napp.MapControllers();\n",
        "server/Controllers/DevicesController.cs": (
            '[ApiController]\n[Route("api/devices")]\npublic class DevicesController {}\n'
        ),
        "server/.env": "SECRET=excluded\n",
        "server/bin/generated.dll": "excluded\n",
        "utilities/Program.cs": "public class Program { public static void Main() {} }\n",
        "infrastructure/main.tf": 'resource "example" "deviceas" {}\n',
    }
    for relative, content in files.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    subprocess.run(["git", "-C", str(root), "init"], check=True, capture_output=True)
    subprocess.run(
        ["git", "-C", str(root), "config", "user.email", "ripple@example.test"],
        check=True,
    )
    subprocess.run(["git", "-C", str(root), "config", "user.name", "Ripple Tests"], check=True)
    subprocess.run(["git", "-C", str(root), "add", "."], check=True)
    subprocess.run(["git", "-C", str(root), "commit", "-m", "fixture"], check=True, capture_output=True)
    return root


class FakeOllama:
    model = "qwen2.5-coder:7b"

    async def status(self) -> ModelStatus:
        return ModelStatus(available=True, model=self.model, detail="ready")

    async def explain(self, facts, evidence, mode) -> ValidatedExplanation:
        return ValidatedExplanation(
            content=FolderExplanationContent(
                summary=f"{facts.folder} defines source components.",
                responsibilities=["Groups related definitions."],
                evidence=[EvidenceCitation(evidence_id=evidence[0].id, reason="Supplied source.")],
                uncertainties=["Runtime behavior was not analyzed."],
            ),
            all_citations_valid=True,
        )

    async def synthesize_overview(self, summaries) -> RepositoryOverviewContent:
        return RepositoryOverviewContent(summary="Grounded overview.", uncertainties=[])


def test_explorer_inventory_readme_and_exclusions(tmp_path: Path) -> None:
    root = _deviceas_fixture(tmp_path)
    repository = RepositoryRecord(
        id="deviceas",
        name="DeviceAS",
        path=str(root),
        added_at=datetime.now(UTC),
    )
    analyzer = RepositoryAnalyzer()

    inventory = analyzer.inventory(repository)
    assert {entry.path for entry in inventory.entries} == {
        "README.md",
        "infrastructure",
        "server",
        "utilities",
    }
    readme = analyzer.readme(repository)
    assert [section.heading for section in readme.sections] == ["DeviceAS", "Development"]
    analysis = analyzer.analyze_folder(repository, "server")
    assert analysis.facts.file_count == 3
    assert all(".env" not in item.file and "/bin/" not in item.file for item in analysis.evidence)


def test_explorer_is_available_through_its_mounted_api(tmp_path: Path) -> None:
    root = _deviceas_fixture(tmp_path)
    client = TestClient(create_app(ollama=FakeOllama(), data_dir=tmp_path / "data"))

    created = client.post("/api/repositories", json={"path": str(root), "name": "DeviceAS"})
    assert created.status_code == 201
    repository_id = created.json()["id"]

    inventory = client.get(f"/api/repositories/{repository_id}/inventory")
    readme = client.get(f"/api/repositories/{repository_id}/readme")
    explanation = client.get(
        f"/api/repositories/{repository_id}/explanation",
        params={"folder": "server", "mode": "full"},
    )
    assert inventory.status_code == 200
    assert readme.json()["found"] is True
    assert explanation.json()["verified_citations"] is True


def test_explorer_rejects_folder_traversal(tmp_path: Path) -> None:
    root = _deviceas_fixture(tmp_path)
    repository = RepositoryRecord(
        id="deviceas",
        name="DeviceAS",
        path=str(root),
        added_at=datetime.now(UTC),
    )
    try:
        RepositoryAnalyzer().analyze_folder(repository, "../outside")
    except (ValueError, FileNotFoundError):
        return
    raise AssertionError("Repository traversal should have been rejected")

