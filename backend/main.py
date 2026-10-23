from __future__ import annotations

import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from .cache import ExplanationCache
from .models import (
    FolderExplanation,
    ModelStatus,
    ReadmeDocument,
    RepositoryCreate,
    RepositoryInventory,
    RepositoryOverview,
    RepositoryRecord,
    ReviewUpdate,
)
from .ollama import PROMPT_VERSION, OllamaClient, OllamaError
from .registry import RepositoryRegistry
from .repository import AnalysisBundle, RepositoryAnalyzer


def create_app(
    *,
    registry: RepositoryRegistry | None = None,
    analyzer: RepositoryAnalyzer | None = None,
    ollama: OllamaClient | None = None,
    data_dir: Path | None = None,
) -> FastAPI:
    default_storage = Path(__file__).resolve().parent.parent / ".ripple"
    storage = data_dir or Path(os.getenv("RIPPLE_DATA_DIR", str(default_storage)))
    repository_registry = registry or RepositoryRegistry(storage)
    repository_analyzer = analyzer or RepositoryAnalyzer()
    ollama_client = ollama or OllamaClient()
    cache = ExplanationCache(storage / "ripple.sqlite3")

    app = FastAPI(
        title="Ripple API",
        version="2.0.0",
        description="Local, evidence-grounded source repository exploration.",
    )
    origins = os.getenv("RIPPLE_CORS_ORIGINS", "http://localhost:4200,http://127.0.0.1:4200").split(",")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[origin.strip() for origin in origins],
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )

    def get_repository(repo_id: str) -> RepositoryRecord:
        try:
            return repository_registry.get(repo_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except (ValueError, PermissionError, FileNotFoundError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    def analyze(repository: RepositoryRecord, folder: str) -> AnalysisBundle:
        try:
            return repository_analyzer.analyze_folder(repository, folder)
        except (ValueError, OSError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    async def build_explanation(
        repository: RepositoryRecord,
        folder: str,
        mode: Literal["preview", "full"],
    ) -> FolderExplanation:
        bundle = analyze(repository, folder)
        commit, _, _ = repository_analyzer.git_state(Path(repository.path))
        key = cache.make_key(
            repository.id,
            commit,
            bundle.facts.folder,
            bundle.facts.state_hash,
            bundle.facts.evidence_hash,
            ollama_client.model,
            PROMPT_VERSION,
            mode,
        )
        cached_result = cache.get(key)
        reviewed = cache.get_review(repository.id, bundle.facts.folder, bundle.facts.evidence_hash)
        if cached_result:
            content, generated_at, citations_valid = cached_result
            return FolderExplanation(
                repository_id=repository.id,
                folder=bundle.facts.folder,
                mode=mode,
                facts=bundle.facts,
                explanation=content,
                evidence=bundle.evidence,
                model=ollama_client.model,
                prompt_version=PROMPT_VERSION,
                commit=commit,
                generated_at=generated_at,
                cached=True,
                verified_citations=citations_valid,
                review_state="reviewed" if reviewed else "unreviewed",
            )
        try:
            result = await ollama_client.explain(bundle.facts, bundle.evidence, mode)
        except OllamaError as error:
            return FolderExplanation(
                repository_id=repository.id,
                folder=bundle.facts.folder,
                mode=mode,
                facts=bundle.facts,
                explanation=None,
                evidence=bundle.evidence,
                model=ollama_client.model,
                prompt_version=PROMPT_VERSION,
                commit=commit,
                generated_at=None,
                cached=False,
                verified_citations=False,
                review_state="reviewed" if reviewed else "unreviewed",
                error=str(error),
            )
        generated_at = datetime.now(UTC)
        cache.put(key, result.content, result.all_citations_valid)
        return FolderExplanation(
            repository_id=repository.id,
            folder=bundle.facts.folder,
            mode=mode,
            facts=bundle.facts,
            explanation=result.content,
            evidence=bundle.evidence,
            model=ollama_client.model,
            prompt_version=PROMPT_VERSION,
            commit=commit,
            generated_at=generated_at,
            cached=False,
            verified_citations=result.all_citations_valid,
            review_state="reviewed" if reviewed else "unreviewed",
        )

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "model": ollama_client.model}

    @app.get("/api/model/status", response_model=ModelStatus)
    async def model_status() -> ModelStatus:
        return await ollama_client.status()

    @app.get("/api/repositories", response_model=list[RepositoryRecord])
    async def list_repositories() -> list[RepositoryRecord]:
        return repository_registry.list()

    @app.post("/api/repositories", response_model=RepositoryRecord, status_code=201)
    async def register_repository(request: RepositoryCreate) -> RepositoryRecord:
        try:
            return repository_registry.add(Path(request.path), request.name)
        except (ValueError, PermissionError, FileNotFoundError, OSError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.get("/api/repositories/{repo_id}/inventory", response_model=RepositoryInventory)
    async def repository_inventory(repo_id: str) -> RepositoryInventory:
        repository = get_repository(repo_id)
        try:
            return repository_analyzer.inventory(repository)
        except OSError as error:
            raise HTTPException(status_code=422, detail=f"Could not scan repository: {error}") from error

    @app.get("/api/repositories/{repo_id}/readme", response_model=ReadmeDocument)
    async def repository_readme(repo_id: str) -> ReadmeDocument:
        repository = get_repository(repo_id)
        try:
            return repository_analyzer.readme(repository)
        except (OSError, UnicodeError) as error:
            raise HTTPException(status_code=422, detail=f"Could not read repository README: {error}") from error

    @app.get("/api/repositories/{repo_id}/explanation", response_model=FolderExplanation)
    async def folder_explanation(
        repo_id: str,
        folder: str = Query(min_length=1),
        mode: Literal["preview", "full"] = "full",
    ) -> FolderExplanation:
        return await build_explanation(get_repository(repo_id), folder, mode)

    @app.post("/api/repositories/{repo_id}/review")
    async def update_review(
        repo_id: str,
        update: ReviewUpdate,
        folder: str = Query(min_length=1),
    ) -> dict[str, str]:
        repository = get_repository(repo_id)
        bundle = analyze(repository, folder)
        cache.set_review(repository.id, bundle.facts.folder, bundle.facts.evidence_hash, update.reviewed)
        return {"review_state": "reviewed" if update.reviewed else "unreviewed"}

    @app.get("/api/repositories/{repo_id}/overview", response_model=RepositoryOverview)
    async def repository_overview(repo_id: str) -> RepositoryOverview:
        repository = get_repository(repo_id)
        inventory = repository_analyzer.inventory(repository)
        folder_summaries: list[dict[str, str]] = []
        uncertainties: list[str] = []
        for entry in inventory.entries:
            if entry.kind != "folder":
                continue
            result = await build_explanation(repository, entry.path, "full")
            if result.explanation:
                folder_summaries.append({"folder": entry.path, "summary": result.explanation.summary})
                uncertainties.extend(result.explanation.uncertainties)
            else:
                uncertainties.append(f"{entry.path}: {result.error or 'No explanation available'}")
        if not folder_summaries:
            summary = "No grounded folder summaries are available."
        else:
            try:
                synthesis = await ollama_client.synthesize_overview(folder_summaries)
                summary = synthesis.summary
                uncertainties.extend(synthesis.uncertainties)
            except OllamaError as error:
                summary = "Repository overview unavailable; individual folder summaries remain available."
                uncertainties.append(str(error))
        return RepositoryOverview(
            repository_id=repository.id,
            commit=inventory.commit,
            summary=summary,
            folder_summaries=folder_summaries,
            uncertainties=uncertainties[:20],
            generated_at=datetime.now(UTC),
            model=ollama_client.model,
        )

    return app


app = create_app()

