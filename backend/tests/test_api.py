from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from backend.main import create_app
from backend.models import (
    EvidenceCitation,
    FolderExplanationContent,
    ModelStatus,
    RepositoryOverviewContent,
)
from backend.ollama import OllamaError, ValidatedExplanation


class FakeOllama:
    model = "qwen2.5-coder:7b"

    def __init__(self, fail: bool = False) -> None:
        self.calls = 0
        self.fail = fail

    async def status(self) -> ModelStatus:
        return ModelStatus(available=True, model=self.model, detail="ready")

    async def explain(self, facts, evidence, mode) -> ValidatedExplanation:
        self.calls += 1
        if self.fail:
            raise OllamaError("model unavailable")
        return ValidatedExplanation(
            content=FolderExplanationContent(
                summary=f"{facts.folder} defines source components.",
                responsibilities=["Groups related source definitions."],
                evidence=[EvidenceCitation(evidence_id=evidence[0].id, reason="The supplied source shows it.")],
                uncertainties=["Runtime behavior was not analyzed."],
            ),
            all_citations_valid=True,
        )

    async def synthesize_overview(self, folder_summaries) -> RepositoryOverviewContent:
        return RepositoryOverviewContent(summary="A grounded repository overview.", uncertainties=[])


def test_register_list_inventory_explain_cache_and_review(tmp_path: Path, deviceas_repo: Path) -> None:
    fake = FakeOllama()
    app = create_app(ollama=fake, data_dir=tmp_path / "api-data")
    client = TestClient(app)

    created = client.post(
        "/api/repositories", json={"path": str(deviceas_repo), "name": "DeviceAS"}
    )
    assert created.status_code == 201
    repository = created.json()
    assert client.get("/api/repositories").json()[0]["id"] == repository["id"]

    inventory = client.get(f"/api/repositories/{repository['id']}/inventory")
    assert inventory.status_code == 200
    assert any(item["path"] == "server" for item in inventory.json()["entries"])

    readme = client.get(f"/api/repositories/{repository['id']}/readme")
    assert readme.status_code == 200
    assert readme.json()["path"] == "README.md"
    assert readme.json()["sections"][0]["heading"] == "DeviceAS"

    params = {"folder": "server", "mode": "full"}
    first = client.get(f"/api/repositories/{repository['id']}/explanation", params=params)
    second = client.get(f"/api/repositories/{repository['id']}/explanation", params=params)
    assert first.status_code == 200
    assert first.json()["cached"] is False
    assert second.json()["cached"] is True
    assert fake.calls == 1

    review = client.post(
        f"/api/repositories/{repository['id']}/review",
        params={"folder": "server"},
        json={"reviewed": True},
    )
    assert review.json()["review_state"] == "reviewed"
    reviewed = client.get(f"/api/repositories/{repository['id']}/explanation", params=params)
    assert reviewed.json()["review_state"] == "reviewed"


def test_missing_repository_and_path_validation(tmp_path: Path) -> None:
    client = TestClient(create_app(ollama=FakeOllama(), data_dir=tmp_path / "data"))
    assert client.get("/api/repositories/missing/inventory").status_code == 404
    response = client.post("/api/repositories", json={"path": str(tmp_path / "absent")})
    assert response.status_code == 422


def test_model_failure_keeps_deterministic_facts_available(
    tmp_path: Path, deviceas_repo: Path
) -> None:
    client = TestClient(create_app(ollama=FakeOllama(fail=True), data_dir=tmp_path / "data"))
    repository = client.post("/api/repositories", json={"path": str(deviceas_repo)}).json()
    result = client.get(
        f"/api/repositories/{repository['id']}/explanation",
        params={"folder": "server", "mode": "preview"},
    )
    body = result.json()
    assert result.status_code == 200
    assert body["facts"]["file_count"] == 4
    assert body["explanation"] is None
    assert "model unavailable" in body["error"]


def test_repository_overview_is_hierarchical(tmp_path: Path, deviceas_repo: Path) -> None:
    client = TestClient(create_app(ollama=FakeOllama(), data_dir=tmp_path / "data"))
    repository = client.post("/api/repositories", json={"path": str(deviceas_repo)}).json()
    response = client.get(f"/api/repositories/{repository['id']}/overview")
    body = response.json()
    assert response.status_code == 200
    assert body["summary"] == "A grounded repository overview."
    assert {item["folder"] for item in body["folder_summaries"]} == {
        "infrastructure",
        "server",
        "tests",
        "utilities",
    }

