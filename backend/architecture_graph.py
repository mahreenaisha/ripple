"""Strict loading and validation for Roslyn architecture graph artifacts."""

from __future__ import annotations

import copy
import json
from pathlib import Path, PurePosixPath
from typing import Any


class ArchitectureGraphError(ValueError):
    """Raised when an architecture graph is missing or invalid."""


NODE_KINDS = {"service", "entrypoint", "database", "queue", "external", "unresolved"}
EDGE_KINDS = {
    "handles",
    "queries",
    "publishes",
    "consumes",
    "calls_external",
    "unresolved_dependency",
}
CONFIDENCE = {"high", "medium", "low"}
RESOLUTION = {"direct", "inferred", "unresolved"}


def _require(value: Any, expected: type, location: str) -> Any:
    if not isinstance(value, expected):
        raise ArchitectureGraphError(f"{location} must be {expected.__name__}")
    return value


def _source_path(value: Any, location: str) -> str:
    path = _require(value, str, location)
    parsed = PurePosixPath(path.replace("\\", "/"))
    if not path or parsed.is_absolute() or ".." in parsed.parts:
        raise ArchitectureGraphError(f"{location} must be repository-relative")
    return path


def _validate_source(source: Any, location: str) -> None:
    item = _require(source, dict, location)
    _source_path(item.get("file"), f"{location}.file")
    line = item.get("line")
    if not isinstance(line, int) or isinstance(line, bool) or line < 1:
        raise ArchitectureGraphError(f"{location}.line must be a positive integer")
    _require(item.get("symbol"), str, f"{location}.symbol")


def _validate_flow_ids(value: Any, location: str) -> None:
    flow_ids = _require(value, list, location)
    if not all(isinstance(flow_id, str) and flow_id for flow_id in flow_ids):
        raise ArchitectureGraphError(f"{location} must contain non-empty strings")


def validate_architecture_graph(data: Any) -> dict:
    root = _require(data, dict, "architecture-graph")
    if _require(root.get("schema_version"), str, "schema_version") != "1.0.0":
        raise ArchitectureGraphError("Unsupported architecture graph schema")
    _require(root.get("generator"), dict, "generator")
    analysis = _require(root.get("analysis"), dict, "analysis")
    if analysis.get("mode") != "study":
        raise ArchitectureGraphError("Architecture graph must be source-only study analysis")
    nodes = _require(root.get("nodes"), list, "nodes")
    edges = _require(root.get("edges"), list, "edges")
    _require(root.get("warnings", []), list, "warnings")

    node_ids: set[str] = set()
    for index, node in enumerate(nodes):
        where = f"nodes[{index}]"
        item = _require(node, dict, where)
        node_id = _require(item.get("id"), str, f"{where}.id")
        if not node_id or node_id in node_ids:
            raise ArchitectureGraphError(f"{where}.id must be unique and non-empty")
        node_ids.add(node_id)
        if item.get("kind") not in NODE_KINDS:
            raise ArchitectureGraphError(f"{where}.kind is unsupported")
        _require(item.get("label"), str, f"{where}.label")
        if item.get("confidence") not in CONFIDENCE:
            raise ArchitectureGraphError(f"{where}.confidence is unsupported")
        if item.get("resolution") not in RESOLUTION:
            raise ArchitectureGraphError(f"{where}.resolution is unsupported")
        _validate_flow_ids(item.get("flow_ids"), f"{where}.flow_ids")
        if item.get("source") is not None:
            _validate_source(item["source"], f"{where}.source")

    edge_ids: set[str] = set()
    for index, edge in enumerate(edges):
        where = f"edges[{index}]"
        item = _require(edge, dict, where)
        edge_id = _require(item.get("id"), str, f"{where}.id")
        if not edge_id or edge_id in edge_ids:
            raise ArchitectureGraphError(f"{where}.id must be unique and non-empty")
        edge_ids.add(edge_id)
        source = _require(item.get("source"), str, f"{where}.source")
        target = _require(item.get("target"), str, f"{where}.target")
        if source not in node_ids or target not in node_ids:
            raise ArchitectureGraphError(f"{where} references a missing node")
        if item.get("kind") not in EDGE_KINDS:
            raise ArchitectureGraphError(f"{where}.kind is unsupported")
        if item.get("confidence") not in CONFIDENCE:
            raise ArchitectureGraphError(f"{where}.confidence is unsupported")
        if item.get("resolution") not in RESOLUTION:
            raise ArchitectureGraphError(f"{where}.resolution is unsupported")
        evidence = _require(item.get("evidence"), list, f"{where}.evidence")
        if not evidence:
            raise ArchitectureGraphError(f"{where}.evidence must not be empty")
        for evidence_index, observation in enumerate(evidence):
            evidence_where = f"{where}.evidence[{evidence_index}]"
            _validate_source(observation, evidence_where)
            _require(observation.get("reason"), str, f"{evidence_where}.reason")
            if observation.get("confidence") not in CONFIDENCE:
                raise ArchitectureGraphError(f"{evidence_where}.confidence is unsupported")
            if observation.get("resolution") not in RESOLUTION:
                raise ArchitectureGraphError(f"{evidence_where}.resolution is unsupported")
        _validate_flow_ids(item.get("flow_ids"), f"{where}.flow_ids")
    return root


def load_architecture_graph(path: str | Path) -> dict:
    artifact_path = Path(path)
    try:
        data = json.loads(artifact_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ArchitectureGraphError(
            f"Architecture graph not found: {artifact_path}"
        ) from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise ArchitectureGraphError(
            f"Could not read architecture graph {artifact_path}: {exc}"
        ) from exc
    return validate_architecture_graph(data)


def architecture_graph_catalog(data: dict) -> dict:
    return copy.deepcopy(data)
