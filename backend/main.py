import json
import os
import re
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from pydantic import BaseModel

from architecture_graph import (
    ArchitectureGraphError,
    architecture_graph_catalog,
    load_architecture_graph,
)
from knowledge import (
    KnowledgeError,
    add_fact,
    attach_knowledge,
    load_knowledge,
    read_repo_line,
)
from request_flows import (
    RequestFlowError,
    flow_to_mermaid,
    get_flow,
    get_glossary_term,
    get_step,
    load_request_flows,
    request_flow_catalog,
)
from scans import ScanError, ScanManager

load_dotenv()

app = FastAPI()
UI_ORIGINS = [
    origin.strip()
    for origin in os.environ.get(
        "RIPPLE_UI_ORIGINS",
        "http://localhost:4200,http://127.0.0.1:4200",
    ).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=UI_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BACKEND_DIR = Path(__file__).resolve().parent
REPO_ROOT = BACKEND_DIR.parent
SNAPSHOTS_DIR = REPO_ROOT / "snapshots"
KNOWLEDGE_DIR = REPO_ROOT / "knowledge"
DEFAULT_SNAPSHOT = "deviceas"
DEFAULT_KNOWLEDGE = KNOWLEDGE_DIR / f"{DEFAULT_SNAPSHOT}.yaml"
SNAPSHOT_SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]*$")

_active_snapshot: str | None = None


def _snapshots_dir() -> Path:
    return _resolve_path("RIPPLE_SNAPSHOTS_DIR", SNAPSHOTS_DIR)


def _active_snapshot_name() -> str:
    configured = _active_snapshot or os.environ.get("RIPPLE_SNAPSHOT", "").strip()
    if configured:
        return configured
    root = _snapshots_dir()
    preferred = root / DEFAULT_SNAPSHOT / "request-flows.json"
    if preferred.is_file():
        return DEFAULT_SNAPSHOT
    if root.is_dir():
        available = sorted(
            directory.name
            for directory in root.iterdir()
            if directory.is_dir() and (directory / "request-flows.json").is_file()
        )
        if available:
            return available[0]
    return DEFAULT_SNAPSHOT


def _snapshot_file(name: str) -> Path:
    return _snapshots_dir() / _active_snapshot_name() / name


def _snapshot_summary(directory: Path) -> dict:
    manifest_path = directory / "snapshot.json"
    manifest = {}
    if manifest_path.is_file():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            manifest = {}
    graph_path = directory / "architecture-graph.json"
    if graph_path.is_file():
        try:
            graph = load_architecture_graph(graph_path)
            map_capability = {
                "status": "ready",
                "schema_version": graph["schema_version"],
            }
        except ArchitectureGraphError as exc:
            map_capability = {"status": "invalid", "reason": str(exc)}
    elif (directory / "graph.json").is_file():
        map_capability = {
            "status": "legacy",
            "reason": "Rescan this repository to create an evidence-backed Map.",
        }
    else:
        map_capability = {
            "status": "missing",
            "reason": "Rescan this repository to create its Map.",
        }
    return {
        "slug": directory.name,
        "name": manifest.get("name") or directory.name,
        "source": manifest.get("source"),
        "analysis": manifest.get("analysis"),
        "counts": manifest.get("counts"),
        "durationMs": manifest.get("durationMs"),
        "has_knowledge": (KNOWLEDGE_DIR / f"{directory.name}.yaml").is_file(),
        "capabilities": {
            "flows": {"status": "ready"},
            "map": map_capability,
        },
    }


def _list_snapshots() -> list[dict]:
    root = _snapshots_dir()
    if not root.is_dir():
        return []
    return [
        _snapshot_summary(directory)
        for directory in sorted(root.iterdir())
        if directory.is_dir() and (directory / "request-flows.json").is_file()
    ]


def _activate_scanned_snapshot(slug: str) -> None:
    global _active_snapshot
    _active_snapshot = slug


class ChatContext(BaseModel):
    type: Literal["flow"] = "flow"
    flow_id: str | None = None
    step_id: str | int | None = None
    term: str | None = None


class ChatRequest(BaseModel):
    message: str
    context: ChatContext | None = None


class ScanPreflightRequest(BaseModel):
    repo_path: str


class StartScanRequest(BaseModel):
    repo_path: str
    name: str | None = None


def _resolve_path(env_name: str, default: Path) -> Path:
    raw = os.environ.get(env_name, "").strip()
    if not raw:
        return default
    path = Path(raw)
    if not path.is_absolute():
        path = (BACKEND_DIR / path).resolve()
    return path


scan_manager = ScanManager(REPO_ROOT, _snapshots_dir(), _activate_scanned_snapshot)


def _load_knowledge() -> dict:
    try:
        return load_knowledge(
            _resolve_path(
                "KNOWLEDGE_PATH", KNOWLEDGE_DIR / f"{_active_snapshot_name()}.yaml"
            )
        )
    except KnowledgeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


def _load_request_flows() -> dict:
    path = _resolve_path("REQUEST_FLOWS_PATH", _snapshot_file("request-flows.json"))
    try:
        flows = load_request_flows(path)
    except RequestFlowError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return attach_knowledge(flows, _load_knowledge())


def _load_architecture_graph() -> dict:
    path = _resolve_path(
        "ARCHITECTURE_GRAPH_PATH",
        _snapshot_file("architecture-graph.json"),
    )
    try:
        return load_architecture_graph(path)
    except ArchitectureGraphError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


def _strip_markdown(text: str) -> str:
    """Remove common markdown emphasis/headers the free models like to emit."""
    cleaned = []
    for line in text.splitlines():
        stripped = line.lstrip()
        while stripped.startswith("#"):
            stripped = stripped[1:].lstrip()
        if stripped.startswith("- "):
            stripped = stripped[2:]
        elif stripped.startswith("* "):
            stripped = stripped[2:]
        cleaned.append(
            stripped.replace("**", "")
            .replace("__", "")
            .replace("`", "")
            .replace("*", "")
        )
    return "\n".join(cleaned).strip()


def _compact_flow_evidence(flow: dict, step_id: int | None = None) -> dict:
    """Keep only what the local model needs — not full evidence blobs."""
    raw_steps = flow.get("steps", [])
    # Cap prompt size: long step lists dominate local-model latency.
    keep = raw_steps[:8]
    if step_id is not None:
        selected = next((s for s in raw_steps if s.get("id") == step_id), None)
        if selected and selected not in keep:
            keep = keep[:-1] + [selected] if keep else [selected]
    steps = [
        {
            "id": step.get("id"),
            "kind": step.get("kind"),
            "label": step.get("label"),
            "symbol": step.get("symbol"),
            "file": step.get("file"),
            "line": step.get("line"),
            **({"doc": step["doc"]} if step.get("doc") else {}),
        }
        for step in keep
    ]
    compact = {
        "id": flow.get("id"),
        "service": flow.get("service"),
        "trigger": flow.get("trigger"),
        "confidence": flow.get("confidence"),
        "step_count": len(raw_steps),
        "steps": steps,
    }
    story = flow.get("story")
    if story:
        compact["story"] = {
            "category": story.get("category"),
            "summary": story.get("summary"),
            "triggered_by": (story.get("triggeredBy") or {}).get("label"),
            "checks": [
                f"{member['label']}: {member.get('summary', '')}".strip(": ")
                for group in story.get("fanOut", [])
                for member in group.get("members", [])
            ][:10],
            "metrics": [metric["name"] for metric in story.get("produces", {}).get("metrics", [])],
            "touches": [item["system"] for item in story.get("produces", {}).get("boundaries", [])],
            "settings": [f"{item['key']} = {item['human']}" for item in story.get("timing", [])],
        }
    if flow.get("knowledge"):
        compact["team_knowledge"] = [
            {
                "title": fact["title"],
                "text": fact["text"],
                "source": _fact_source_label(fact),
                "verified": fact["verified"],
            }
            for fact in flow["knowledge"]
        ]
    if step_id is not None:
        selected = get_step(flow, step_id)
        if selected:
            compact["selected_step"] = {
                "id": selected.get("id"),
                "kind": selected.get("kind"),
                "label": selected.get("label"),
                "symbol": selected.get("symbol"),
                "file": selected.get("file"),
                "line": selected.get("line"),
            }
    return compact


def _fact_source_label(fact: dict) -> str:
    source = fact.get("source") or {}
    if source.get("type") == "person":
        role = f", {source['role']}" if source.get("role") else ""
        return f"{source.get('name', 'a teammate')}{role}"
    if source.get("path"):
        return f"{source['path']}:{source['line']}" if source.get("line") else source["path"]
    return source.get("type", "unknown")


def _flow_chat_prompt(context: ChatContext, flows: dict) -> str:
    evidence: dict = {
        "flow_id": context.flow_id,
        "step_id": context.step_id,
        "term": context.term,
        "analysis": flows.get("analysis")
        or {"mode": "study", "completeness": "partial", "limitations": []},
    }
    if context.term:
        evidence["glossary"] = get_glossary_term(flows, context.term)
    if context.flow_id:
        flow = get_flow(flows, context.flow_id)
        if flow:
            evidence["flow"] = _compact_flow_evidence(flow, context.step_id)
    return (
        "You are Ripple, explaining code to a new engineer. Answer in 2-4 short "
        "plain sentences. No markdown, no lists, no follow-up questions. Use only "
        "the evidence below and do not invent steps. For why-questions, rely on "
        "story.summary and team_knowledge. When you use team knowledge, name its "
        "source, and say so if it is not verified. Mention when something is "
        "static inference rather than runtime proof. If analysis.mode is study, "
        "state that the result is partial source-only analysis whenever discussing "
        "completeness, missing calls, or unresolved behavior.\n"
        f"Evidence: {json.dumps(evidence, separators=(',', ':'))}"
    )


def _provider_status() -> dict:
    provider = os.environ.get("LLM_PROVIDER", "openrouter").strip().lower()
    if provider == "ollama":
        return {
            "provider": "ollama",
            # 3B fits a 4GB GPU; 8B spills to CPU and feels 10s+.
            "model": os.environ.get("OLLAMA_MODEL", "llama3.2:3b"),
            "available": True,
            "reason": "configured",
        }
    if provider == "openrouter":
        available = bool(os.environ.get("OPENROUTER_API_KEY", "").strip())
        return {
            "provider": "openrouter",
            "model": os.environ.get("OPENROUTER_MODEL", "openrouter/free"),
            "available": available,
            "reason": "configured" if available else "API key is not configured",
        }
    return {
        "provider": provider or "unknown",
        "model": None,
        "available": False,
        "reason": "unsupported provider",
    }


def _openai_client() -> tuple[OpenAI, str] | None:
    status = _provider_status()
    if not status["available"]:
        return None
    if status["provider"] == "ollama":
        return (
            OpenAI(
                base_url=os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434/v1"),
                api_key="ollama",
                # Local models are slower; allow a longer first token.
                timeout=float(os.environ.get("OLLAMA_TIMEOUT", "90")),
                max_retries=0,
            ),
            status["model"],
        )
    return (
        OpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=os.environ["OPENROUTER_API_KEY"],
            timeout=15.0,
            max_retries=0,
        ),
        status["model"],
    )


def _offline_flow_explanation(flows: dict, context: ChatContext) -> str:
    analysis = flows.get("analysis") or {}
    study_prefix = (
        "This is a partial source-only study snapshot, so external packages, generated "
        "code, project conditions, and runtime choices may be missing. "
        if analysis.get("mode") == "study"
        else ""
    )
    if context.term:
        item = get_glossary_term(flows, context.term)
        if item:
            return study_prefix + f"{item['term']}: {item['definition']}"
        return study_prefix + f"The glossary has no definition for '{context.term}'."

    if not context.flow_id:
        return study_prefix + (
            "Offline mode needs a selected flow_id to explain a request flow. "
            f"The artifact contains {len(flows['flows'])} flows."
        )
    flow = get_flow(flows, context.flow_id)
    if not flow:
        return study_prefix + f"The selected request flow '{context.flow_id}' was not found."

    if context.step_id is not None:
        step = get_step(flow, context.step_id)
        if not step:
            return study_prefix + (
                f"The selected step '{context.step_id}' was not found in "
                f"flow '{context.flow_id}'."
            )
        evidence = " ".join(step["evidence"])
        return study_prefix + (
            f"{step['id']} is a {step['kind']} step named "
            f"'{step['label']}'. It points to {step['file']} line "
            f"{step['line']} with {step['confidence']} confidence. "
            f"Evidence: {evidence} This is static scanner evidence, not "
            "proof of runtime behavior."
        )

    story = flow.get("story") or {}
    if story.get("summary"):
        facts = " ".join(
            f"{fact['title']}: {fact['text']} (Source: {_fact_source_label(fact)}"
            f"{'' if fact['verified'] else ', not yet verified'}.)"
            for fact in flow.get("knowledge", [])
        )
        return study_prefix + (
            f"{story['summary']} {facts}".strip()
            + " This comes from static source evidence and team notes, not a runtime trace."
        )

    descriptions = []
    for step in flow["steps"]:
        descriptions.append(
            f"{step['id']} {step['kind']} '{step['label']}' at "
            f"{step['file']} line {step['line']}"
        )
    return study_prefix + (
        f"Flow '{flow['id']}' starts from {flow['trigger']['label']} in "
        f"service {flow['service']}. The evidence-backed order is: "
        + "; then ".join(descriptions)
        + f". Overall confidence is {flow.get('confidence', 'unknown')}. "
        "This is a static path inferred from source evidence, not a runtime trace."
    )


@app.get("/")
def root():
    return {
        "service": "ripple-request-flows",
        "endpoints": [
            "/request-flows",
            "/architecture-graph",
            "/request-flows/{flow_id}",
            "/request-flows/{flow_id}/mermaid",
            "/knowledge",
            "/snapshots",
            "/snapshots/active",
            "/scans/preflight",
            "/scans",
            "/scans/{job_id}",
            "/chat",
            "/chat/status",
            "/docs",
        ],
    }


@app.get("/request-flows")
def get_request_flow_catalog():
    return request_flow_catalog(_load_request_flows())


@app.get("/architecture-graph")
def get_architecture_graph():
    return architecture_graph_catalog(_load_architecture_graph())


@app.get("/knowledge")
def get_knowledge():
    return _load_knowledge()


def _repo_root() -> Path:
    manifest_path = _snapshot_file("snapshot.json")
    manifest = {}
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    raw = os.environ.get("RIPPLE_REPO_PATH", "").strip() or (manifest.get("source") or {}).get("localPath")
    if not raw or not Path(raw).is_dir():
        raise HTTPException(
            status_code=409,
            detail="Ripple does not know where this repo is on disk. Re-scan it with scanner/scan-repo.js.",
        )
    return Path(raw)


def _check_repo_file(path: str, line: int | None) -> dict:
    try:
        return read_repo_line(_repo_root(), path, line)
    except KnowledgeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class NewFactRequest(BaseModel):
    title: str
    text: str
    kind: Literal["doc", "rule"] = "doc"
    path: str
    line: int | None = None
    triggers: list[str] = []
    boundaries: list[str] = []


@app.get("/repo-file")
def get_repo_file(path: str, line: int | None = None):
    return _check_repo_file(path, line)


@app.post("/knowledge/facts")
def post_knowledge_fact(request: NewFactRequest):
    if not request.title.strip() or not request.text.strip():
        raise HTTPException(status_code=400, detail="Give the fact a title and a description")
    applies_to = {
        key: [value for value in values if value.strip()]
        for key, values in (("triggers", request.triggers), ("boundaries", request.boundaries))
    }
    applies_to = {key: values for key, values in applies_to.items() if values}
    if not applies_to:
        raise HTTPException(status_code=400, detail="Pick at least one flow trigger or system it applies to")
    checked = _check_repo_file(request.path, request.line)
    source = {"type": "doc" if checked["path"].endswith((".md", ".txt", ".adoc")) else "code", "path": checked["path"]}
    if request.line is not None:
        source["line"] = request.line
    fact = {
        "kind": request.kind,
        "title": request.title.strip(),
        "text": request.text.strip(),
        "applies_to": applies_to,
        "source": source,
        "verified": True,
    }
    current = next((item for item in _list_snapshots() if item["slug"] == _active_snapshot_name()), None)
    try:
        saved = add_fact(
            _resolve_path("KNOWLEDGE_PATH", KNOWLEDGE_DIR / f"{_active_snapshot_name()}.yaml"),
            (current or {}).get("name") or _active_snapshot_name(),
            fact,
        )
    except KnowledgeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {**saved, "excerpt": checked.get("excerpt")}


class ActiveSnapshotRequest(BaseModel):
    slug: str


@app.get("/snapshots")
def get_snapshots():
    snapshots = _list_snapshots()
    active = _active_snapshot_name()
    current = next((item for item in snapshots if item["slug"] == active), None)
    return {"active": active, "current": current, "snapshots": snapshots}


@app.post("/snapshots/active")
def set_active_snapshot(request: ActiveSnapshotRequest):
    global _active_snapshot
    slug = request.slug.strip().lower()
    if not SNAPSHOT_SLUG.match(slug) or not (
        _snapshots_dir() / slug / "request-flows.json"
    ).is_file():
        raise HTTPException(status_code=404, detail=f"No scanned snapshot named '{slug}'")
    _active_snapshot = slug
    return get_snapshots()


def _scan_response(action):
    try:
        return action()
    except ScanError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@app.post("/scans/preflight")
def preflight_scan(request: ScanPreflightRequest):
    return _scan_response(lambda: scan_manager.preflight(request.repo_path))


@app.post("/scans", status_code=202)
def start_scan(request: StartScanRequest):
    return _scan_response(
        lambda: scan_manager.start(
            request.repo_path,
            request.name,
        )
    )


@app.get("/scans/{job_id}")
def get_scan(job_id: str):
    return _scan_response(lambda: scan_manager.status(job_id))


@app.post("/scans/{job_id}/cancel")
def cancel_scan(job_id: str):
    return _scan_response(lambda: scan_manager.cancel(job_id))


@app.get("/request-flows/{flow_id}")
def get_request_flow(flow_id: str):
    flow = get_flow(_load_request_flows(), flow_id)
    if not flow:
        raise HTTPException(
            status_code=404,
            detail=f"Request flow '{flow_id}' not found",
        )
    return flow


@app.get("/request-flows/{flow_id}/mermaid")
def get_request_flow_mermaid(flow_id: str):
    flow = get_flow(_load_request_flows(), flow_id)
    if not flow:
        raise HTTPException(
            status_code=404,
            detail=f"Request flow '{flow_id}' not found",
        )
    return {"flow_id": flow_id, "mermaid": flow_to_mermaid(flow)}


@app.get("/chat/status")
def chat_status():
    return _provider_status()


@app.post("/chat")
def chat(body: ChatRequest):
    context = body.context or ChatContext()
    flows = _load_request_flows()
    provider = _openai_client()
    if provider is None:
        return {
            "response": _offline_flow_explanation(flows, context),
            "mode": "offline",
        }
    client, model = provider

    messages = [
        {
            "role": "system",
            "content": _flow_chat_prompt(context, flows),
        },
        {"role": "user", "content": body.message},
    ]

    try:
        status = _provider_status()
        request: dict = {"model": model, "messages": messages}
        if status["provider"] == "ollama":
            # Short answers + smaller context keep laptop GPUs under ~10s.
            request["max_tokens"] = int(os.environ.get("OLLAMA_MAX_TOKENS", "160"))
            request["temperature"] = 0.2
            request["extra_body"] = {
                "options": {
                    "num_predict": int(os.environ.get("OLLAMA_MAX_TOKENS", "160")),
                    "num_ctx": int(os.environ.get("OLLAMA_NUM_CTX", "2048")),
                }
            }
        completion = client.chat.completions.create(**request)
        return {
            "response": _strip_markdown(
                completion.choices[0].message.content or "(empty reply)"
            ),
            "mode": "online",
        }
    except HTTPException:
        raise
    except Exception as exc:
        response = _offline_flow_explanation(flows, context)
        return {
            "response": (
                f"{response} The configured language model did not respond, "
                "so Ripple used its evidence-only fallback."
            ),
            "mode": "offline",
            "provider_error": type(exc).__name__,
        }
