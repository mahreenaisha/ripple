from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock

from explorer_models import FolderExplanationContent


class ExplanationCache:
    def __init__(self, database: Path) -> None:
        database.parent.mkdir(parents=True, exist_ok=True)
        self.database = database
        self._lock = RLock()
        self._initialize()

    @staticmethod
    def make_key(
        repository_id: str,
        commit: str,
        folder: str,
        folder_state_hash: str,
        evidence_hash: str,
        model: str,
        prompt_version: str,
        mode: str,
    ) -> str:
        values = [
            repository_id,
            commit,
            folder,
            folder_state_hash,
            evidence_hash,
            model,
            prompt_version,
            mode,
        ]
        return hashlib.sha256("\0".join(values).encode()).hexdigest()

    def get(self, key: str) -> tuple[FolderExplanationContent, datetime, bool] | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload, created_at FROM explanations WHERE cache_key = ?", (key,)
            ).fetchone()
        if not row:
            return None
        created_at = datetime.fromisoformat(row[1]).replace(tzinfo=UTC)
        decoded = json.loads(row[0])
        if "content" in decoded:
            content = FolderExplanationContent.model_validate(decoded["content"])
            citations_valid = bool(decoded.get("all_citations_valid", False))
        else:
            content = FolderExplanationContent.model_validate(decoded)
            citations_valid = False
        return content, created_at, citations_valid

    def put(self, key: str, content: FolderExplanationContent, all_citations_valid: bool) -> None:
        payload = json.dumps(
            {
                "content": content.model_dump(mode="json"),
                "all_citations_valid": all_citations_valid,
            }
        )
        with self._lock, self._connect() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO explanations(cache_key, payload, created_at) VALUES (?, ?, datetime('now'))",
                (key, payload),
            )

    def get_review(self, repository_id: str, folder: str, evidence_hash: str) -> bool:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT reviewed FROM reviews WHERE repository_id = ? AND folder = ? AND evidence_hash = ?",
                (repository_id, folder, evidence_hash),
            ).fetchone()
        return bool(row and row[0])

    def set_review(self, repository_id: str, folder: str, evidence_hash: str, reviewed: bool) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO reviews(repository_id, folder, evidence_hash, reviewed, updated_at)
                VALUES (?, ?, ?, ?, datetime('now'))
                """,
                (repository_id, folder, evidence_hash, int(reviewed)),
            )

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS explanations (
                    cache_key TEXT PRIMARY KEY,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS reviews (
                    repository_id TEXT NOT NULL,
                    folder TEXT NOT NULL,
                    evidence_hash TEXT NOT NULL,
                    reviewed INTEGER NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(repository_id, folder, evidence_hash)
                );
                """
            )

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.database, timeout=10)

