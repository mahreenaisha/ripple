from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from .models import (
    EvidenceItem,
    FolderFacts,
    LanguageCount,
    ReadmeDocument,
    ReadmeSection,
    RepositoryInventory,
    RepositoryRecord,
    RootEntry,
)

EXCLUDED_DIRECTORIES = {
    ".git",
    ".angular",
    ".idea",
    ".next",
    ".nuxt",
    ".pytest_cache",
    ".venv",
    ".vscode",
    "__pycache__",
    "bin",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "obj",
    "out",
    "target",
    "venv",
}
SECRET_NAMES = {
    ".env",
    ".env.local",
    ".env.production",
    "credentials.json",
    "id_rsa",
    "id_ed25519",
    "secrets.json",
}
SECRET_SUFFIXES = {".key", ".p12", ".pfx", ".pem"}
MANIFEST_NAMES = {
    "angular.json",
    "build.gradle",
    "build.gradle.kts",
    "cargo.toml",
    "docker-compose.yml",
    "docker-compose.yaml",
    "dockerfile",
    "go.mod",
    "package.json",
    "pom.xml",
    "pyproject.toml",
    "requirements.txt",
}
MANIFEST_SUFFIXES = {".csproj", ".fsproj", ".sln"}
ENTRY_NAMES = {
    "app.py",
    "index.js",
    "index.ts",
    "main.go",
    "main.py",
    "main.ts",
    "program.cs",
    "server.js",
    "startup.cs",
}
LANGUAGES = {
    ".cs": "C#",
    ".fs": "F#",
    ".go": "Go",
    ".html": "HTML",
    ".java": "Java",
    ".js": "JavaScript",
    ".json": "JSON",
    ".kt": "Kotlin",
    ".md": "Markdown",
    ".py": "Python",
    ".rb": "Ruby",
    ".rs": "Rust",
    ".scss": "SCSS",
    ".sql": "SQL",
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".tf": "Terraform",
    ".xml": "XML",
    ".yaml": "YAML",
    ".yml": "YAML",
}
SOURCE_SUFFIXES = {
    ".cs",
    ".fs",
    ".go",
    ".java",
    ".js",
    ".kt",
    ".py",
    ".rb",
    ".rs",
    ".ts",
    ".tsx",
}
INTERESTING_LINE = re.compile(
    r"(\[(ApiController|Route|Http(Get|Post|Put|Delete|Patch))|"
    r"\b(class|interface|record|enum|def|func|function)\s+\w+|"
    r"\b(public|export)\s+|"
    r"\b(Map(Get|Post|Put|Delete|Patch)|Add\w+|Use\w+)\s*\()",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class AnalysisBundle:
    facts: FolderFacts
    evidence: list[EvidenceItem]


class RepositoryAnalyzer:
    def __init__(self, max_file_bytes: int = 1_000_000, max_evidence_items: int = 16, max_evidence_chars: int = 60_000):
        self.max_file_bytes = max_file_bytes
        self.max_evidence_items = max_evidence_items
        self.max_evidence_chars = max_evidence_chars

    def inventory(self, repository: RepositoryRecord) -> RepositoryInventory:
        root = Path(repository.path).resolve(strict=True)
        entries: list[RootEntry] = []
        for path in sorted(root.iterdir(), key=lambda item: (not item.is_dir(), item.name.casefold())):
            if self._excluded(path):
                continue
            if path.is_dir():
                files = list(self._iter_files(path, root))
                entries.append(self._entry_for_directory(path, root, files))
            elif path.is_file() and self._safe_file(path, root):
                entries.append(self._entry_for_file(path, root))
        commit, branch, dirty = self.git_state(root)
        return RepositoryInventory(
            repository=repository,
            commit=commit,
            branch=branch,
            dirty=dirty,
            generated_at=datetime.now(UTC),
            entries=entries,
        )

    def readme(self, repository: RepositoryRecord) -> ReadmeDocument:
        root = Path(repository.path).resolve(strict=True)
        candidates = [
            path
            for path in root.iterdir()
            if path.is_file()
            and not path.is_symlink()
            and path.name.casefold() in {"readme.md", "readme", "readme.txt", "readme.rst"}
            and self._safe_file(path, root)
        ]
        if not candidates:
            return ReadmeDocument(
                found=False,
                path=None,
                word_count=0,
                reading_minutes=0,
                state_hash=hashlib.sha256(b"").hexdigest(),
                sections=[],
            )
        priority = {"readme.md": 0, "readme": 1, "readme.txt": 2, "readme.rst": 3}
        path = sorted(candidates, key=lambda item: (priority[item.name.casefold()], item.name))[0]
        content = self._read_text(path)
        lines = content.splitlines()
        sections = self._readme_sections(lines)
        word_count = len(re.findall(r"\b[\w'-]+\b", content))
        return ReadmeDocument(
            found=True,
            path=self._relative(path, root),
            word_count=word_count,
            reading_minutes=max(1, (word_count + 219) // 220),
            state_hash=hashlib.sha256(content.encode()).hexdigest(),
            sections=sections,
        )

    def analyze_folder(self, repository: RepositoryRecord, folder: str) -> AnalysisBundle:
        root = Path(repository.path).resolve(strict=True)
        target = self._contained(root, folder)
        if target == root or not target.is_dir():
            raise ValueError("Select a folder inside the repository")
        files = list(self._iter_files(target, root))
        state_hash = self._state_hash(files, root)
        evidence = self._select_evidence(files, root, target)
        canonical = json.dumps(
            [item.model_dump(mode="json") for item in evidence],
            sort_keys=True,
            separators=(",", ":"),
        )
        evidence_hash = hashlib.sha256(canonical.encode()).hexdigest()
        languages = self._languages(files)
        manifests = [self._relative(path, root) for path in files if self._is_manifest(path)]
        entry_points = [self._relative(path, root) for path in files if path.name.casefold() in ENTRY_NAMES]
        directories = {path.parent for path in files if path.parent != target}
        return AnalysisBundle(
            facts=FolderFacts(
                folder=self._relative(target, root),
                file_count=len(files),
                directory_count=len(directories),
                languages=languages,
                manifests=manifests,
                entry_points=entry_points,
                state_hash=state_hash,
                evidence_hash=evidence_hash,
            ),
            evidence=evidence,
        )

    def _entry_for_directory(self, path: Path, root: Path, files: list[Path]) -> RootEntry:
        directories = {file.parent for file in files if file.parent != path}
        return RootEntry(
            name=path.name,
            path=self._relative(path, root),
            kind="folder",
            file_count=len(files),
            directory_count=len(directories),
            languages=self._languages(files),
            manifests=[self._relative(file, root) for file in files if self._is_manifest(file)],
            state_hash=self._state_hash(files, root),
        )

    def _entry_for_file(self, path: Path, root: Path) -> RootEntry:
        language = LANGUAGES.get(path.suffix.casefold())
        return RootEntry(
            name=path.name,
            path=self._relative(path, root),
            kind="file",
            file_count=1,
            languages=[LanguageCount(language=language, files=1)] if language else [],
            manifests=[self._relative(path, root)] if self._is_manifest(path) else [],
            state_hash=self._state_hash([path], root),
        )

    def _iter_files(self, directory: Path, root: Path):
        for current, directories, filenames in os.walk(directory, followlinks=False):
            current_path = Path(current)
            directories[:] = sorted(
                [
                    name
                    for name in directories
                    if name.casefold() not in EXCLUDED_DIRECTORIES
                    and not (current_path / name).is_symlink()
                    and self._inside((current_path / name).resolve(), root)
                ],
                key=str.casefold,
            )
            for name in sorted(filenames, key=str.casefold):
                path = current_path / name
                if self._safe_file(path, root):
                    yield path

    def _safe_file(self, path: Path, root: Path) -> bool:
        try:
            resolved = path.resolve(strict=True)
            return (
                path.is_file()
                and not path.is_symlink()
                and self._inside(resolved, root)
                and not self._excluded(path)
                and os.access(path, os.R_OK)
            )
        except (OSError, RuntimeError):
            return False

    @staticmethod
    def _inside(path: Path, root: Path) -> bool:
        try:
            path.relative_to(root)
            return True
        except ValueError:
            return False

    def _contained(self, root: Path, relative: str) -> Path:
        if not relative or Path(relative).is_absolute():
            raise ValueError("Folder must be a repository-relative path")
        target = (root / relative).resolve(strict=True)
        if not self._inside(target, root):
            raise ValueError("Folder escapes the repository")
        return target

    @staticmethod
    def _excluded(path: Path) -> bool:
        name = path.name.casefold()
        return (
            name in EXCLUDED_DIRECTORIES
            or name in SECRET_NAMES
            or path.suffix.casefold() in SECRET_SUFFIXES
            or name.startswith(".env.")
        )

    @staticmethod
    def _relative(path: Path, root: Path) -> str:
        return path.relative_to(root).as_posix()

    @staticmethod
    def _is_manifest(path: Path) -> bool:
        return path.name.casefold() in MANIFEST_NAMES or path.suffix.casefold() in MANIFEST_SUFFIXES

    def _languages(self, files: list[Path]) -> list[LanguageCount]:
        counts: dict[str, int] = {}
        for path in files:
            language = LANGUAGES.get(path.suffix.casefold())
            if language:
                counts[language] = counts.get(language, 0) + 1
        return [
            LanguageCount(language=language, files=count)
            for language, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
        ]

    def _state_hash(self, files: list[Path], root: Path) -> str:
        aggregate = hashlib.sha256()
        for path in sorted(files, key=lambda item: self._relative(item, root)):
            file_hash = hashlib.sha256()
            try:
                with path.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(131_072), b""):
                        file_hash.update(chunk)
            except OSError:
                continue
            record = f"{self._relative(path, root)}:{file_hash.hexdigest()}\n"
            aggregate.update(record.encode())
        return aggregate.hexdigest()

    def _select_evidence(self, files: list[Path], root: Path, folder: Path) -> list[EvidenceItem]:
        ranked: list[tuple[int, str, Path, str]] = []
        for path in files:
            name = path.name.casefold()
            relative = self._relative(path, root)
            if name.startswith("readme"):
                ranked.append((0, relative, path, "readme"))
            elif self._is_manifest(path):
                ranked.append((1, relative, path, "manifest"))
            elif name in ENTRY_NAMES:
                ranked.append((2, relative, path, "entry_point"))
            elif path.suffix.casefold() in SOURCE_SUFFIXES:
                category = self._source_category(path)
                ranked.append((3 if category != "sample" else 5, relative, path, category))
            elif name.endswith((".yaml", ".yml", ".json", ".toml", ".tf")):
                ranked.append((4, relative, path, "configuration"))

        evidence: list[EvidenceItem] = []
        total_chars = 0
        for _, relative, path, category in sorted(ranked, key=lambda item: (item[0], item[1])):
            excerpt = self._excerpt(path, category)
            if not excerpt:
                continue
            start, end, content = excerpt
            if total_chars + len(content) > self.max_evidence_chars:
                continue
            scope = "folder"
            if category in {"api", "declaration", "dependency", "entry_point", "sample"}:
                scope = "file"
            elif folder == root:
                scope = "repository"
            evidence.append(
                EvidenceItem(
                    id=f"E{len(evidence) + 1}",
                    file=relative,
                    start_line=start,
                    end_line=end,
                    category=category,  # type: ignore[arg-type]
                    scope=scope,  # type: ignore[arg-type]
                    content=content,
                )
            )
            total_chars += len(content)
            if len(evidence) >= self.max_evidence_items:
                break
        return evidence

    def _source_category(self, path: Path) -> str:
        try:
            text = self._read_text(path)
        except (OSError, UnicodeError):
            return "sample"
        lowered = text.casefold()
        if any(token in lowered for token in ("[route", "[httpget", "[httppost", "mapget(", "mappost(", "@app.route")):
            return "api"
        if any(token in lowered for token in ("addsingleton", "addscoped", "addtransient", "services.add", "container.register")):
            return "dependency"
        if INTERESTING_LINE.search(text):
            return "declaration"
        return "sample"

    def _excerpt(self, path: Path, category: str) -> tuple[int, int, str] | None:
        try:
            text = self._read_text(path)
        except (OSError, UnicodeError):
            return None
        if "\x00" in text:
            return None
        lines = text.splitlines()
        if not lines:
            return None
        if category in {"readme", "manifest", "configuration", "entry_point"}:
            start, end = 1, min(len(lines), 120 if category != "readme" else 160)
        else:
            match = next((index for index, line in enumerate(lines) if INTERESTING_LINE.search(line)), 0)
            start = max(1, match + 1 - 8)
            end = min(len(lines), match + 1 + 45)
        content = "\n".join(lines[start - 1 : end])
        return start, end, content

    def _read_text(self, path: Path) -> str:
        if path.stat().st_size > self.max_file_bytes:
            raise OSError("File exceeds evidence limit")
        return path.read_text(encoding="utf-8")

    @staticmethod
    def _readme_sections(lines: list[str]) -> list[ReadmeSection]:
        headings: list[tuple[int, int, str]] = []
        for index, line in enumerate(lines):
            match = re.match(r"^(#{1,6})\s+(.+?)\s*#*\s*$", line)
            if match:
                headings.append((index, len(match.group(1)), match.group(2).strip()))
        boundaries: list[tuple[int, int, str]]
        if not headings:
            boundaries = [(0, 1, "Overview")] if lines else []
        elif headings[0][0] > 0 and any(line.strip() for line in lines[: headings[0][0]]):
            boundaries = [(0, 1, "Introduction"), *headings]
        else:
            boundaries = headings

        sections: list[ReadmeSection] = []
        used_ids: dict[str, int] = {}
        for position, (heading_line, level, heading) in enumerate(boundaries):
            is_real_heading = bool(re.match(r"^#{1,6}\s+", lines[heading_line])) if lines else False
            content_start = heading_line + 1 if is_real_heading else heading_line
            next_line = boundaries[position + 1][0] if position + 1 < len(boundaries) else len(lines)
            body = "\n".join(lines[content_start:next_line]).strip()
            base_id = re.sub(r"[^a-z0-9]+", "-", heading.casefold()).strip("-") or "section"
            occurrence = used_ids.get(base_id, 0) + 1
            used_ids[base_id] = occurrence
            section_id = base_id if occurrence == 1 else f"{base_id}-{occurrence}"
            sections.append(
                ReadmeSection(
                    id=section_id,
                    heading=heading,
                    level=level,
                    start_line=heading_line + 1,
                    end_line=max(heading_line + 1, next_line),
                    content=body,
                )
            )
        return sections

    @staticmethod
    def git_state(root: Path) -> tuple[str, str | None, bool]:
        def run(*args: str) -> str:
            result = subprocess.run(
                ["git", "-C", str(root), *args],
                check=True,
                capture_output=True,
                text=True,
                timeout=10,
            )
            return result.stdout.strip()

        try:
            commit = run("rev-parse", "HEAD")
            branch = run("branch", "--show-current") or None
            dirty = bool(run("status", "--porcelain", "--untracked-files=normal"))
            return commit, branch, dirty
        except (subprocess.SubprocessError, OSError):
            return "unknown", None, True

