"""Team knowledge facts attached to request flows by trigger, symbol, or boundary."""

from __future__ import annotations

import copy
import re
from pathlib import Path
from typing import Any

import yaml

FACT_KINDS = {"tribal", "doc", "rule"}
MATCH_KEYS = ("triggers", "symbols", "boundaries", "categories")


class KnowledgeError(ValueError):
    """Raised when a knowledge file is malformed."""


def _string_list(value: Any, where: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
        raise KnowledgeError(f"{where} must be a list of non-empty strings")
    return value


def validate_knowledge(data: Any) -> dict:
    if not isinstance(data, dict):
        raise KnowledgeError("knowledge file must be a mapping")
    if data.get("schema_version") != 1:
        raise KnowledgeError("schema_version must be 1")
    facts = data.get("facts") or []
    if not isinstance(facts, list):
        raise KnowledgeError("facts must be a list")
    seen: set[str] = set()
    for index, fact in enumerate(facts):
        where = f"facts[{index}]"
        if not isinstance(fact, dict):
            raise KnowledgeError(f"{where} must be a mapping")
        for field in ("id", "title", "text"):
            if not isinstance(fact.get(field), str) or not fact[field].strip():
                raise KnowledgeError(f"{where}.{field} must be a non-empty string")
        if fact["id"] in seen:
            raise KnowledgeError(f"{where}.id is duplicated: {fact['id']}")
        seen.add(fact["id"])
        if fact.get("kind") not in FACT_KINDS:
            raise KnowledgeError(f"{where}.kind must be one of {sorted(FACT_KINDS)}")
        applies_to = fact.get("applies_to")
        if not isinstance(applies_to, dict):
            raise KnowledgeError(f"{where}.applies_to must be a mapping")
        if not any(_string_list(applies_to.get(key), f"{where}.applies_to.{key}") for key in MATCH_KEYS):
            raise KnowledgeError(f"{where}.applies_to must name at least one match")
        if not isinstance(fact.get("source"), dict) or not fact["source"].get("type"):
            raise KnowledgeError(f"{where}.source.type is required")
        if not isinstance(fact.get("verified"), bool):
            raise KnowledgeError(f"{where}.verified must be true or false")
    terms = data.get("terms") or {}
    if not isinstance(terms, dict) or not all(
        isinstance(key, str) and isinstance(value, str) for key, value in terms.items()
    ):
        raise KnowledgeError("terms must map strings to strings")
    return {**data, "facts": facts, "terms": terms}


def load_knowledge(path: str | Path) -> dict:
    """Return an empty knowledge set when the file is absent; knowledge is optional."""
    knowledge_path = Path(path)
    if not knowledge_path.is_file():
        return {"schema_version": 1, "facts": [], "terms": {}}
    try:
        data = yaml.safe_load(knowledge_path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise KnowledgeError(f"Could not read knowledge file {knowledge_path}: {exc}") from exc
    return validate_knowledge(data)


def _class_of(symbol: str) -> str:
    return symbol.rsplit(".", 1)[0] if "." in symbol else symbol


def _flow_boundaries(flow: dict) -> set[str]:
    systems = {
        item.get("system", "")
        for item in (flow.get("story") or {}).get("produces", {}).get("boundaries", [])
    }
    for path in [flow.get("steps") or [], *(flow.get("branches") or [])]:
        for step in path:
            if step.get("kind") in {"database", "external", "queue"}:
                systems.add(step.get("label", ""))
    return {system for system in systems if system}


def match_reason(fact: dict, flow: dict) -> str | None:
    applies = fact["applies_to"]
    trigger = flow.get("trigger") or {}
    trigger_names = {trigger.get("label"), trigger.get("message_type")}
    for name in applies.get("triggers") or []:
        if name in trigger_names:
            return f"trigger {name}"
    steps = flow.get("steps") or []
    for name in applies.get("symbols") or []:
        for step in steps:
            symbol = step.get("symbol", "")
            if symbol == name or _class_of(symbol) == name:
                return f"step {symbol}"
    boundaries = _flow_boundaries(flow)
    for name in applies.get("boundaries") or []:
        if any(name.lower() in system.lower() for system in boundaries):
            return f"touches {name}"
    category = (flow.get("story") or {}).get("category")
    for name in applies.get("categories") or []:
        if name == category:
            return f"category {name}"
    return None


def facts_for_flow(knowledge: dict, flow: dict) -> list[dict]:
    matched = []
    for fact in knowledge.get("facts", []):
        reason = match_reason(fact, flow)
        if reason:
            matched.append({**copy.deepcopy(fact), "matched_by": reason})
    order = {"rule": 0, "tribal": 1, "doc": 2}
    return sorted(matched, key=lambda fact: (order.get(fact["kind"], 3), fact["id"]))


MAX_SOURCE_BYTES = 2_000_000


def read_repo_line(repo_root: str | Path, relative_path: str, line: int | None = None) -> dict:
    """Confirm a file (and optional line) exists inside the scanned repo and return an excerpt."""
    root = Path(repo_root).resolve()
    cleaned = relative_path.strip().replace("\\", "/").lstrip("/")
    if not cleaned:
        raise KnowledgeError("Give a file path inside the repo")
    target = (root / cleaned).resolve()
    if not target.is_relative_to(root):
        raise KnowledgeError("The file must be inside the repo")
    if not target.is_file():
        raise KnowledgeError(f"No file at {cleaned} in the repo")
    if target.stat().st_size > MAX_SOURCE_BYTES:
        raise KnowledgeError(f"{cleaned} is too large to cite")
    lines = target.read_text(encoding="utf-8", errors="replace").splitlines()
    result: dict[str, Any] = {"path": target.relative_to(root).as_posix(), "lines": len(lines)}
    if line is not None:
        if line < 1 or line > len(lines):
            raise KnowledgeError(f"{cleaned} has {len(lines)} lines; line {line} does not exist")
        result["line"] = line
        result["excerpt"] = lines[line - 1].strip()
    return result


def _fact_id(title: str, existing: set[str]) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:48] or "fact"
    candidate, suffix = base, 2
    while candidate in existing:
        candidate, suffix = f"{base}-{suffix}", suffix + 1
    return candidate


def add_fact(knowledge_path: str | Path, repo_name: str, fact: dict) -> dict:
    """Append a fact to the knowledge file, creating it when the repo has none yet."""
    path = Path(knowledge_path)
    header = ""
    if path.is_file():
        raw = path.read_text(encoding="utf-8")
        for line in raw.splitlines(keepends=True):
            if not line.startswith("#"):
                break
            header += line
        data = validate_knowledge(yaml.safe_load(raw))
    else:
        data = {"schema_version": 1, "repo": repo_name, "facts": [], "terms": {}}
    new_fact = {"id": _fact_id(fact["title"], {item["id"] for item in data["facts"]}), **fact}
    updated = validate_knowledge({**data, "facts": [*data["facts"], new_fact]})
    body = yaml.safe_dump(updated, sort_keys=False, allow_unicode=True, width=88)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(header + body, encoding="utf-8")
    return new_fact


def attach_knowledge(flows: dict, knowledge: dict) -> dict:
    """Return a copy of a request-flow artifact with facts and team terms merged in."""
    result = copy.deepcopy(flows)
    for flow in result["flows"]:
        flow["knowledge"] = facts_for_flow(knowledge, flow)
    result["glossary"] = {**result.get("glossary", {}), **knowledge.get("terms", {})}
    return result
