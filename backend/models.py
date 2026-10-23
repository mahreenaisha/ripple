from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class RepositoryCreate(BaseModel):
    path: str = Field(min_length=1)
    name: str | None = Field(default=None, max_length=100)


class RepositoryRecord(BaseModel):
    id: str
    name: str
    path: str
    added_at: datetime


class LanguageCount(BaseModel):
    language: str
    files: int


class RootEntry(BaseModel):
    name: str
    path: str
    kind: Literal["folder", "file"]
    file_count: int
    directory_count: int = 0
    languages: list[LanguageCount] = Field(default_factory=list)
    manifests: list[str] = Field(default_factory=list)
    state_hash: str


class RepositoryInventory(BaseModel):
    repository: RepositoryRecord
    commit: str
    dirty: bool
    branch: str | None
    generated_at: datetime
    entries: list[RootEntry]


class ReadmeSection(BaseModel):
    id: str
    heading: str
    level: int
    start_line: int
    end_line: int
    content: str


class ReadmeDocument(BaseModel):
    found: bool
    path: str | None
    word_count: int
    reading_minutes: int
    state_hash: str
    sections: list[ReadmeSection]


class EvidenceItem(BaseModel):
    id: str
    file: str
    start_line: int
    end_line: int
    category: Literal[
        "readme", "manifest", "entry_point", "api", "declaration", "dependency", "configuration", "sample"
    ]
    scope: Literal["repository", "folder", "file"]
    content: str


class FolderFacts(BaseModel):
    folder: str
    file_count: int
    directory_count: int
    languages: list[LanguageCount]
    manifests: list[str]
    entry_points: list[str]
    state_hash: str
    evidence_hash: str


class EvidenceCitation(BaseModel):
    evidence_id: str
    reason: str = Field(min_length=1, max_length=500)


class FolderExplanationContent(BaseModel):
    summary: str = Field(min_length=1, max_length=1200)
    responsibilities: list[str] = Field(max_length=8)
    evidence: list[EvidenceCitation] = Field(max_length=16)
    uncertainties: list[str] = Field(max_length=8)


class FolderExplanation(BaseModel):
    repository_id: str
    folder: str
    mode: Literal["preview", "full"]
    facts: FolderFacts
    explanation: FolderExplanationContent | None
    evidence: list[EvidenceItem]
    model: str
    prompt_version: str
    commit: str
    generated_at: datetime | None
    cached: bool
    verified_citations: bool
    review_state: Literal["unreviewed", "reviewed"]
    error: str | None = None


class ReviewUpdate(BaseModel):
    reviewed: bool


class RepositoryOverview(BaseModel):
    repository_id: str
    commit: str
    summary: str
    folder_summaries: list[dict[str, str]]
    uncertainties: list[str]
    generated_at: datetime
    model: str


class RepositoryOverviewContent(BaseModel):
    summary: str = Field(min_length=1, max_length=1800)
    uncertainties: list[str] = Field(max_length=8)


class ModelStatus(BaseModel):
    available: bool
    model: str
    detail: str

