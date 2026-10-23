from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.registry import RepositoryRegistry
from backend.repository import RepositoryAnalyzer


def test_deviceas_golden_inventory_has_perfect_structural_precision_and_recall(
    repository, deviceas_repo: Path
) -> None:
    golden_path = Path(__file__).parent / "fixtures" / "deviceas_golden.json"
    golden = json.loads(golden_path.read_text(encoding="utf-8"))
    inventory = RepositoryAnalyzer().inventory(repository)
    actual = {entry.path for entry in inventory.entries}
    expected = set(golden["expected_root_entries"])

    precision = len(actual & expected) / len(actual)
    recall = len(actual & expected) / len(expected)
    assert precision == 1.0
    assert recall == 1.0
    assert inventory.commit != "unknown"
    assert inventory.dirty is False

    server = RepositoryAnalyzer().analyze_folder(repository, "server")
    evidence_paths = {item.file for item in server.evidence}
    assert set(golden["server_evidence_anchors"]) <= evidence_paths


def test_evidence_is_deterministic_prioritized_and_excludes_secrets_and_build_output(repository) -> None:
    analyzer = RepositoryAnalyzer()
    first = analyzer.analyze_folder(repository, "server")
    second = analyzer.analyze_folder(repository, "server")

    assert first == second
    paths = [item.file for item in first.evidence]
    assert paths[0].endswith(".csproj")
    assert any(path.endswith("Program.cs") for path in paths)
    assert any(path.endswith("DevicesController.cs") for path in paths)
    assert not any(".env" in path or "/bin/" in path for path in paths)
    assert first.facts.file_count == 4
    assert first.facts.evidence_hash == second.facts.evidence_hash
    assert first.facts.state_hash == second.facts.state_hash


def test_root_readme_is_split_into_deterministic_reading_sections(repository, deviceas_repo: Path) -> None:
    readme_path = deviceas_repo / "README.md"
    readme_path.write_text(
        "# DeviceAS\n\nRepository purpose.\n\n## Development\n\nRun the service locally.\n",
        encoding="utf-8",
    )
    first = RepositoryAnalyzer().readme(repository)
    second = RepositoryAnalyzer().readme(repository)

    assert first == second
    assert first.found is True
    assert first.path == "README.md"
    assert [section.heading for section in first.sections] == ["DeviceAS", "Development"]
    assert first.sections[1].content == "Run the service locally."
    assert first.reading_minutes == 1
    assert first.state_hash


def test_missing_root_readme_is_explicit(repository, deviceas_repo: Path) -> None:
    (deviceas_repo / "README.md").unlink()
    document = RepositoryAnalyzer().readme(repository)
    assert document.found is False
    assert document.path is None
    assert document.sections == []


def test_folder_state_and_evidence_hashes_change_when_relevant_code_changes(repository, deviceas_repo: Path) -> None:
    analyzer = RepositoryAnalyzer()
    before = analyzer.analyze_folder(repository, "server")
    controller = deviceas_repo / "server/Waters.DeviceAS.Server/Controllers/DevicesController.cs"
    controller.write_text(controller.read_text() + "\npublic record DeviceSummary(string Id);\n", encoding="utf-8")
    after = analyzer.analyze_folder(repository, "server")

    assert after.facts.state_hash != before.facts.state_hash
    assert after.facts.evidence_hash != before.facts.evidence_hash


def test_unselected_file_change_still_invalidates_folder_state(repository, deviceas_repo: Path) -> None:
    analyzer = RepositoryAnalyzer(max_evidence_items=1)
    before = analyzer.analyze_folder(repository, "server")
    config = deviceas_repo / "server/Waters.DeviceAS.Server/new-notes.txt"
    config.write_text("a relevant tracked folder file", encoding="utf-8")
    after = analyzer.analyze_folder(repository, "server")

    assert after.facts.state_hash != before.facts.state_hash
    assert after.facts.evidence_hash == before.facts.evidence_hash


@pytest.mark.parametrize("folder", ["../outside", "/tmp", "server/../../outside"])
def test_folder_traversal_is_rejected(repository, folder: str) -> None:
    with pytest.raises((ValueError, FileNotFoundError)):
        RepositoryAnalyzer().analyze_folder(repository, folder)


def test_registry_rejects_missing_non_directory_and_non_git_paths(tmp_path: Path) -> None:
    registry = RepositoryRegistry(tmp_path / "data")
    with pytest.raises(FileNotFoundError):
        registry.add(tmp_path / "missing")
    plain = tmp_path / "plain"
    plain.mkdir()
    with pytest.raises(ValueError, match="Git repository"):
        registry.add(plain)


def test_registry_deduplicates_same_resolved_repository(registry, deviceas_repo: Path) -> None:
    original = registry.list()[0]
    duplicate = registry.add(deviceas_repo, "Another label")
    assert duplicate.id == original.id
    assert len(registry.list()) == 1

