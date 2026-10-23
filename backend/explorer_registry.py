from __future__ import annotations

import hashlib
import json
import os
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock

from explorer_models import RepositoryRecord


class RepositoryRegistry:
    """Small local registry. Repository choice stays in each request, never global state."""

    def __init__(self, data_dir: Path | None = None) -> None:
        configured = os.getenv("RIPPLE_DATA_DIR")
        default_storage = Path(__file__).resolve().parent.parent / ".ripple"
        self.data_dir = data_dir or Path(configured or default_storage)
        self.file = self.data_dir / "repositories.json"
        self._lock = RLock()

    def list(self) -> list[RepositoryRecord]:
        with self._lock:
            if not self.file.exists():
                return []
            raw = json.loads(self.file.read_text(encoding="utf-8"))
            return [RepositoryRecord.model_validate(item) for item in raw]

    def add(self, path: Path, name: str | None = None) -> RepositoryRecord:
        resolved = path.expanduser().resolve(strict=True)
        self._validate_repository(resolved)
        repo_id = hashlib.sha256(str(resolved).encode()).hexdigest()[:16]
        records = self.list()
        existing = next((item for item in records if item.id == repo_id), None)
        if existing:
            return existing
        record = RepositoryRecord(
            id=repo_id,
            name=(name or resolved.name).strip(),
            path=str(resolved),
            added_at=datetime.now(UTC),
        )
        with self._lock:
            self.data_dir.mkdir(parents=True, exist_ok=True)
            self.file.write_text(
                json.dumps([*map(lambda item: item.model_dump(mode="json"), records), record.model_dump(mode="json")], indent=2),
                encoding="utf-8",
            )
        return record

    def get(self, repo_id: str) -> RepositoryRecord:
        record = next((item for item in self.list() if item.id == repo_id), None)
        if not record:
            raise KeyError(f"Repository '{repo_id}' is not registered")
        path = Path(record.path)
        if not path.exists():
            raise FileNotFoundError(f"Repository path is no longer available: {path}")
        self._validate_repository(path)
        return record

    @staticmethod
    def _validate_repository(path: Path) -> None:
        if not path.is_dir():
            raise ValueError("Path must be a directory")
        if not (path / ".git").exists():
            raise ValueError("Path must be a readable Git repository")
        if not os.access(path, os.R_OK | os.X_OK):
            raise PermissionError("Repository path is not readable")

