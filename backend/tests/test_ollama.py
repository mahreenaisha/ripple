from __future__ import annotations

import json

import httpx
import pytest

from backend.models import (
    EvidenceCitation,
    EvidenceItem,
    FolderExplanationContent,
    FolderFacts,
    LanguageCount,
)
from backend.ollama import OllamaClient


def facts() -> FolderFacts:
    return FolderFacts(
        folder="server",
        file_count=3,
        directory_count=1,
        languages=[LanguageCount(language="C#", files=3)],
        manifests=["server/Server.csproj"],
        entry_points=["server/Program.cs"],
        state_hash="state",
        evidence_hash="evidence",
    )


def evidence() -> list[EvidenceItem]:
    return [
        EvidenceItem(
            id="E1",
            file="server/Program.cs",
            start_line=1,
            end_line=4,
            category="entry_point",
            scope="file",
            content="builder.Services.AddControllers();",
        )
    ]


def test_citation_validation_removes_unknown_and_duplicate_ids() -> None:
    content = FolderExplanationContent(
        summary="Defines the server composition root.",
        responsibilities=["Registers controllers."],
        evidence=[
            EvidenceCitation(evidence_id="E1", reason="Registration exists."),
            EvidenceCitation(evidence_id="E1", reason="Duplicate."),
            EvidenceCitation(evidence_id="E9", reason="Invented."),
        ],
        uncertainties=[],
    )
    result = OllamaClient._validate_citations(content, {"E1"})

    assert result.all_citations_valid is False
    assert [item.evidence_id for item in result.content.evidence] == ["E1"]
    assert "unsupported evidence references" in result.content.uncertainties[-1]


@pytest.mark.asyncio
async def test_native_structured_output_schema_is_sent_and_parsed(monkeypatch) -> None:
    captured: list[dict] = []
    response_content = FolderExplanationContent(
        summary="Defines API startup.",
        responsibilities=["Registers API dependencies."],
        evidence=[EvidenceCitation(evidence_id="E1", reason="The registration is shown.")],
        uncertainties=[],
    ).model_dump_json()

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {"message": {"content": response_content}}

    class FakeClient:
        def __init__(self, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url: str, json: dict):
            captured.append(json)
            return FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    result = await OllamaClient().explain(facts(), evidence(), "full")

    assert result.content.summary == "Defines API startup."
    schema = captured[0]["format"]
    assert schema["type"] == "object"
    assert set(schema["required"]) >= {"summary", "responsibilities", "evidence", "uncertainties"}
    assert captured[0]["options"]["temperature"] == 0


@pytest.mark.asyncio
async def test_invalid_structured_response_gets_one_corrective_retry(monkeypatch) -> None:
    valid = FolderExplanationContent(
        summary="Defines API startup.",
        responsibilities=[],
        evidence=[EvidenceCitation(evidence_id="E1", reason="Shown.")],
        uncertainties=[],
    ).model_dump_json()
    responses = iter(["not json", valid])
    calls = 0

    class FakeResponse:
        def __init__(self, content: str) -> None:
            self.content = content

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {"message": {"content": self.content}}

    class FakeClient:
        def __init__(self, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url: str, json: dict):
            nonlocal calls
            calls += 1
            return FakeResponse(next(responses))

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    result = await OllamaClient().explain(facts(), evidence(), "preview")
    assert calls == 2
    assert result.all_citations_valid

