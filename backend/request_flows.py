"""Loading, lookup, and Mermaid helpers for request-flow scanner artifacts."""

from __future__ import annotations

import copy
import html
import json
import re
from pathlib import Path
from typing import Any


class RequestFlowError(ValueError):
    """Raised when a request-flow artifact is missing or invalid."""


def _require(value: Any, expected: type, location: str) -> Any:
    if not isinstance(value, expected):
        raise RequestFlowError(f"{location} must be {expected.__name__}")
    return value


def validate_request_flows(data: Any) -> dict:
    """Validate the fields emitted by scanner/extract-request-flows.js."""
    root = _require(data, dict, "request-flows")
    _require(root.get("schema_version"), str, "schema_version")
    flows = _require(root.get("flows"), list, "flows")
    glossary = _require(root.get("glossary"), dict, "glossary")
    if not all(
        isinstance(key, str) and key
        and isinstance(value, str) and value
        for key, value in glossary.items()
    ):
        raise RequestFlowError("glossary must map non-empty strings to strings")
    if "generator" in root:
        _require(root["generator"], dict, "generator")
    if "limits" in root:
        _require(root["limits"], dict, "limits")
    if "warnings" in root:
        _require(root["warnings"], list, "warnings")

    seen_ids: set[str] = set()
    for flow_index, flow in enumerate(flows):
        where = f"flows[{flow_index}]"
        _require(flow, dict, where)
        flow_id = _require(flow.get("id"), str, f"{where}.id")
        if not flow_id or flow_id in seen_ids:
            raise RequestFlowError(f"{where}.id must be unique and non-empty")
        seen_ids.add(flow_id)
        _require(flow.get("service"), str, f"{where}.service")
        _require(flow.get("confidence"), str, f"{where}.confidence")
        trigger = _require(flow.get("trigger"), dict, f"{where}.trigger")
        _require(trigger.get("kind"), str, f"{where}.trigger.kind")
        _require(trigger.get("label"), str, f"{where}.trigger.label")
        steps = _require(flow.get("steps"), list, f"{where}.steps")
        if not steps:
            raise RequestFlowError(f"{where}.steps must not be empty")
        for step_index, step in enumerate(steps):
            step_where = f"{where}.steps[{step_index}]"
            _require(step, dict, step_where)
            for field in ("kind", "symbol", "label", "file", "confidence"):
                _require(step.get(field), str, f"{step_where}.{field}")
            line = step.get("line")
            if not isinstance(line, int) or isinstance(line, bool) or line < 1:
                raise RequestFlowError(f"{step_where}.line must be a positive integer")
            evidence = _require(step.get("evidence"), list, f"{step_where}.evidence")
            if not evidence or not all(isinstance(item, str) and item for item in evidence):
                raise RequestFlowError(
                    f"{step_where}.evidence must contain non-empty strings"
                )
    return root


def load_request_flows(path: str | Path) -> dict:
    artifact_path = Path(path)
    try:
        data = json.loads(artifact_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RequestFlowError(
            f"Request-flow artifact not found: {artifact_path}"
        ) from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise RequestFlowError(
            f"Could not read request-flow artifact {artifact_path}: {exc}"
        ) from exc
    return validate_request_flows(data)


def _public_flow(flow: dict) -> dict:
    result = copy.deepcopy(flow)
    for index, step in enumerate(result["steps"]):
        step["id"] = f"step-{index}"
    return result


def request_flow_catalog(data: dict) -> dict:
    """Return the scanner metadata, complete flows, warnings, and glossary."""
    return {
        "schema_version": data["schema_version"],
        "generator": copy.deepcopy(data.get("generator") or {}),
        "limits": copy.deepcopy(data.get("limits") or {}),
        "flows": [_public_flow(flow) for flow in data["flows"]],
        "warnings": copy.deepcopy(data.get("warnings") or []),
        "glossary": copy.deepcopy(data["glossary"]),
    }


def get_flow(data: dict, flow_id: str) -> dict | None:
    for flow in data["flows"]:
        if flow["id"] == flow_id:
            return _public_flow(flow)
    return None


def get_step(flow: dict, step_id: str | int) -> dict | None:
    raw = str(step_id)
    match = re.fullmatch(r"(?:step-)?(\d+)", raw)
    if not match:
        return None
    index = int(match.group(1))
    steps = flow.get("steps") or []
    if index >= len(steps):
        return None
    step = copy.deepcopy(steps[index])
    step["id"] = f"step-{index}"
    return step


def get_flows_for_service(data: dict, service: str) -> list[dict]:
    return [
        _public_flow(flow)
        for flow in data["flows"]
        if flow["service"] == service
    ]


def get_glossary_term(data: dict, term: str) -> dict | None:
    definition = data["glossary"].get(term)
    if not isinstance(definition, str):
        return None
    return {"term": term, "definition": definition}


def _safe_mermaid_text(value: Any, limit: int = 180) -> str:
    # Mermaid treats newlines, semicolons, and %% as syntax, so remove them
    # before HTML-escaping label metacharacters.
    text = re.sub(r"[\r\n\t]+", " ", str(value))
    text = text.replace(";", ",").replace("%%", "%")
    text = re.sub(r"\s+", " ", text).strip()[:limit]
    return html.escape(text, quote=True)


def flow_to_mermaid(flow: dict) -> str:
    """Generate a syntax-safe Mermaid sequence diagram for one flow."""
    steps = flow.get("steps") or []
    if not steps:
        raise RequestFlowError("Cannot generate Mermaid for a flow without steps")

    lines = ["sequenceDiagram", "  autonumber"]
    for index, step in enumerate(steps):
        label = _safe_mermaid_text(
            f"{step.get('kind', 'step')}: {step.get('label') or step.get('symbol')}"
        )
        lines.append(f"  participant S{index} as {label}")

    if len(steps) == 1:
        lines.append(
            f"  Note over S0: {_safe_mermaid_text(steps[0].get('evidence', [''])[0])}"
        )
    else:
        for index in range(1, len(steps)):
            step = steps[index]
            message = _safe_mermaid_text(step.get("label") or step.get("symbol"))
            lines.append(f"  S{index - 1}->>S{index}: {message}")
            evidence = (step.get("evidence") or [""])[0]
            if evidence:
                lines.append(
                    f"  Note over S{index}: {_safe_mermaid_text(evidence)}"
                )
    return "\n".join(lines)
