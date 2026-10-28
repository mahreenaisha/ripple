from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable


SLUG_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
ACTIVE_PHASES = {"validating", "scanning", "publishing", "cancelling"}
MAX_LOG_LINES = 200


class ScanError(RuntimeError):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


class ScanCancelled(RuntimeError):
    pass


@dataclass
class ScanJob:
    id: str
    repo_path: Path
    name: str
    slug: str
    phase: str = "validating"
    logs: list[str] = field(default_factory=list)
    error: str | None = None
    result: dict | None = None
    cancel_requested: bool = False
    process: subprocess.Popen[str] | None = field(default=None, repr=False)

    def public(self) -> dict:
        return {
            "id": self.id,
            "phase": self.phase,
            "repo_path": str(self.repo_path),
            "name": self.name,
            "slug": self.slug,
            "logs": list(self.logs),
            "error": self.error,
            "result": self.result,
        }


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "repo"


def suggested_name(repo_path: Path) -> str:
    name = re.sub(r"^(wcc|waters)[-_]", "", repo_path.name, flags=re.IGNORECASE)
    return name or repo_path.name


class ScanManager:
    def __init__(
        self,
        repo_root: Path,
        snapshots_dir: Path,
        on_promoted: Callable[[str], None] | None = None,
    ):
        self.repo_root = repo_root.resolve()
        self.snapshots_dir = snapshots_dir.resolve()
        self.jobs_dir = self.repo_root / ".ripple" / "scan-jobs"
        self.on_promoted = on_promoted
        self._jobs: dict[str, ScanJob] = {}
        self._lock = threading.RLock()

    def preflight(self, repo_path: str) -> dict:
        repository = self._repository(repo_path)
        dotnet, version = self._dotnet()
        name = suggested_name(repository)
        return {
            "repo_path": str(repository),
            "name": name,
            "slug": slugify(name),
            "dotnet": {"executable": dotnet, "version": version},
        }

    def start(
        self,
        repo_path: str,
        name: str | None,
    ) -> dict:
        preflight = self.preflight(repo_path)
        repository = Path(preflight["repo_path"])
        display_name = (name or preflight["name"]).strip()
        if not display_name or len(display_name) > 100:
            raise ScanError("Repository name must contain between 1 and 100 characters.")
        slug = slugify(display_name)
        if not SLUG_PATTERN.fullmatch(slug):
            raise ScanError("Repository name did not produce a safe snapshot identifier.")
        with self._lock:
            if any(job.phase in ACTIVE_PHASES for job in self._jobs.values()):
                raise ScanError("Another repository scan is already running.", 409)
            job = ScanJob(
                id=uuid.uuid4().hex,
                repo_path=repository,
                name=display_name,
                slug=slug,
            )
            self._jobs[job.id] = job
        threading.Thread(target=self._execute, args=(job,), daemon=True).start()
        return job.public()

    def status(self, job_id: str) -> dict:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise ScanError(f"Unknown scan job '{job_id}'.", 404)
            return job.public()

    def cancel(self, job_id: str) -> dict:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise ScanError(f"Unknown scan job '{job_id}'.", 404)
            if job.phase not in ACTIVE_PHASES:
                return job.public()
            job.cancel_requested = True
            job.phase = "cancelling"
            process = job.process
        if process is not None and process.poll() is None:
            process.terminate()
        self._log(job, "Cancellation requested.")
        return job.public()

    def _execute(self, job: ScanJob) -> None:
        staging = self.jobs_dir / job.id
        output = staging / "output"
        try:
            staging.mkdir(parents=True, exist_ok=False)
            self._set_phase(job, "scanning")
            node = shutil.which("node")
            if not node:
                raise ScanError("Node.js is not available to run the Ripple scanner.", 503)
            self._run_command(
                job,
                [
                    node,
                    str(self.repo_root / "scanner" / "scan-repo.js"),
                    str(job.repo_path),
                    "--out",
                    str(output),
                    "--name",
                    job.name,
                ],
                self.repo_root,
            )
            self._set_phase(job, "publishing")
            result = self._validate_output(output)
            self._promote(job, output)
            with self._lock:
                job.result = {
                    "snapshot": job.slug,
                    "counts": result["snapshot"].get("counts") or {},
                    "warnings": len(result["flows"].get("warnings") or []),
                    "analysis": result["flows"].get("analysis"),
                }
                job.phase = "complete"
            if self.on_promoted:
                self.on_promoted(job.slug)
            shutil.rmtree(staging, ignore_errors=True)
        except ScanCancelled:
            with self._lock:
                job.phase = "cancelled"
            self._log(job, "Scan cancelled.")
        except ScanError as error:
            with self._lock:
                job.phase = "failed"
                job.error = str(error)
            self._log(job, str(error))
        except Exception as error:
            with self._lock:
                job.phase = "failed"
                job.error = f"Unexpected scan failure: {error}"
            self._log(job, job.error)
        finally:
            with self._lock:
                job.process = None

    def _run_command(self, job: ScanJob, command: list[str], cwd: Path) -> None:
        self._log(job, f"$ {' '.join(command)}")
        process = subprocess.Popen(
            command,
            cwd=cwd,
            env={
                **os.environ,
                "DOTNET_CLI_TELEMETRY_OPTOUT": "1",
                "DOTNET_NOLOGO": "1",
            },
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            shell=False,
        )
        with self._lock:
            job.process = process
        assert process.stdout is not None
        for line in process.stdout:
            self._log(job, line.rstrip())
            if job.cancel_requested:
                process.terminate()
                process.wait(timeout=10)
                raise ScanCancelled()
        return_code = process.wait()
        with self._lock:
            job.process = None
        if job.cancel_requested:
            raise ScanCancelled()
        if return_code != 0:
            raise ScanError(
                f"{Path(command[0]).name} exited with status {return_code}. "
                "Review the scan log for analyzer errors."
            )

    def _validate_output(self, output: Path) -> dict:
        flows_path = output / "request-flows.json"
        snapshot_path = output / "snapshot.json"
        try:
            flows = json.loads(flows_path.read_text(encoding="utf-8"))
            snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        except FileNotFoundError as error:
            raise ScanError(f"Scanner did not produce {error.filename}.") from error
        except json.JSONDecodeError as error:
            raise ScanError(f"Scanner produced invalid JSON: {error}.") from error
        if not isinstance(flows.get("flows"), list) or not isinstance(
            flows.get("warnings"), list
        ):
            raise ScanError("Scanner output does not match the request-flow contract.")
        analysis = flows.get("analysis")
        snapshot_analysis = snapshot.get("analysis")
        if (
            not isinstance(analysis, dict)
            or analysis.get("mode") != "study"
            or snapshot_analysis != analysis
        ):
            raise ScanError(
                "Scanner output is not a source-only study artifact."
            )
        return {"flows": flows, "snapshot": snapshot}

    def _promote(self, job: ScanJob, output: Path) -> None:
        self.snapshots_dir.mkdir(parents=True, exist_ok=True)
        target = (self.snapshots_dir / job.slug).resolve()
        if target.parent != self.snapshots_dir:
            raise ScanError("Snapshot destination escapes the snapshots directory.")
        incoming = self.snapshots_dir / f".{job.slug}-{job.id}.incoming"
        backup = self.snapshots_dir / f".{job.slug}-{job.id}.backup"
        shutil.rmtree(incoming, ignore_errors=True)
        shutil.copytree(output, incoming)
        moved_previous = False
        try:
            if target.exists():
                os.replace(target, backup)
                moved_previous = True
            os.replace(incoming, target)
        except Exception:
            if moved_previous and backup.exists() and not target.exists():
                os.replace(backup, target)
            raise
        finally:
            shutil.rmtree(incoming, ignore_errors=True)
        shutil.rmtree(backup, ignore_errors=True)

    def _repository(self, raw_path: str) -> Path:
        if not raw_path.strip():
            raise ScanError("Enter an absolute repository path.")
        candidate = Path(raw_path).expanduser()
        if not candidate.is_absolute():
            raise ScanError("Repository path must be absolute in the backend environment.")
        try:
            repository = candidate.resolve(strict=True)
        except OSError as error:
            raise ScanError(f"Repository path is not accessible: {error}.") from error
        if not repository.is_dir():
            raise ScanError("Repository path is not a directory.")
        return repository

    def _dotnet(self) -> tuple[str, str]:
        configured = os.environ.get("RIPPLE_DOTNET", "").strip()
        dotnet = configured or shutil.which("dotnet")
        if not dotnet:
            raise ScanError(
                "Ripple requires the .NET 10 SDK in the backend environment. "
                "Windows and WSL installations are separate.",
                503,
            )
        try:
            result = subprocess.run(
                [dotnet, "--version"],
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=10,
                check=True,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise ScanError(f"Could not run the configured dotnet executable: {error}.", 503)
        version = result.stdout.strip()
        try:
            major = int(version.split(".", 1)[0])
        except ValueError as error:
            raise ScanError(f"Could not parse .NET SDK version '{version}'.", 503) from error
        if major < 10:
            raise ScanError(f"Ripple requires .NET 10 SDK or newer; found {version}.", 503)
        return dotnet, version

    def _set_phase(self, job: ScanJob, phase: str) -> None:
        with self._lock:
            if job.cancel_requested:
                raise ScanCancelled()
            job.phase = phase

    def _log(self, job: ScanJob, message: str) -> None:
        cleaned = message.strip()
        if not cleaned:
            return
        with self._lock:
            job.logs.append(cleaned[:1000])
            if len(job.logs) > MAX_LOG_LINES:
                del job.logs[: len(job.logs) - MAX_LOG_LINES]
