import json
import os
import re
from collections import defaultdict, deque
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from pydantic import BaseModel

from graph_builder import build_graph, graph_to_json, load_architecture_graph
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
    get_flows_for_service,
    get_glossary_term,
    get_step,
    load_request_flows,
    request_flow_catalog,
)

load_dotenv()

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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
    return (
        _active_snapshot
        or os.environ.get("RIPPLE_SNAPSHOT", "").strip()
        or DEFAULT_SNAPSHOT
    )


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
    return {
        "slug": directory.name,
        "name": manifest.get("name") or directory.name,
        "source": manifest.get("source"),
        "counts": manifest.get("counts"),
        "durationMs": manifest.get("durationMs"),
        "has_knowledge": (KNOWLEDGE_DIR / f"{directory.name}.yaml").is_file(),
    }


def _list_snapshots() -> list[dict]:
    root = _snapshots_dir()
    if not root.is_dir():
        return []
    return [
        _snapshot_summary(directory)
        for directory in sorted(root.iterdir())
        if directory.is_dir() and (directory / "graph.json").is_file()
    ]


class ChatContext(BaseModel):
    type: Literal["flow", "architecture"] = "architecture"
    flow_id: str | None = None
    step_id: str | int | None = None
    term: str | None = None


class ChatRequest(BaseModel):
    message: str
    context: ChatContext | None = None


CHAT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_architecture_overview",
            "description": (
                "Return a full overview of the architecture: services, "
                "databases, external systems, key dependencies, and SPOF "
                "candidates. Use for explain-the-system questions."
            ),
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_dependents",
            "description": (
                "List nodes that directly depend on (call / query / import) "
                "the given node."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "node_id": {
                        "type": "string",
                        "description": "Node id, e.g. 'Waters.DeviceAS.Server'",
                    }
                },
                "required": ["node_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_dependencies",
            "description": (
                "List nodes that the given node directly depends on."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "node_id": {
                        "type": "string",
                        "description": "Node id, e.g. 'Waters.DeviceAS.Server'",
                    }
                },
                "required": ["node_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_spof_candidates",
            "description": (
                "Return single points of failure: flagged SPOFs plus nodes "
                "with the highest in-degree."
            ),
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_request_flow",
            "description": "Return one evidence-backed request flow by id.",
            "parameters": {
                "type": "object",
                "properties": {"flow_id": {"type": "string"}},
                "required": ["flow_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_request_flow_step",
            "description": "Return one selected step from a request flow.",
            "parameters": {
                "type": "object",
                "properties": {
                    "flow_id": {"type": "string"},
                    "step_id": {
                        "type": "string",
                        "description": "A positional id such as step-2",
                    },
                },
                "required": ["flow_id", "step_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_flows_for_service",
            "description": "Return all request flows belonging to a service.",
            "parameters": {
                "type": "object",
                "properties": {"service": {"type": "string"}},
                "required": ["service"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_request_flow_glossary_term",
            "description": "Return the scanner glossary definition for a term.",
            "parameters": {
                "type": "object",
                "properties": {"term": {"type": "string"}},
                "required": ["term"],
            },
        },
    },
]


def _resolve_path(env_name: str, default: Path) -> Path:
    raw = os.environ.get(env_name, "").strip()
    if not raw:
        return default
    path = Path(raw)
    if not path.is_absolute():
        path = (BACKEND_DIR / path).resolve()
    return path


def _load_graph():
    graph_path = _resolve_path("GRAPH_PATH", _snapshot_file("graph.json"))
    if graph_path.is_file():
        return load_architecture_graph(graph_path)

    synthetic = BACKEND_DIR / "synthetic_traces.json"
    with open(synthetic) as f:
        traces = json.load(f)
    G = build_graph(traces)
    G.graph["source"] = "synthetic"
    return G


def _load_entry_points() -> dict:
    path = _resolve_path("ENTRY_POINTS_PATH", _snapshot_file("entry-points.json"))
    if not path.is_file():
        return {}
    return json.loads(path.read_text())


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


def get_dependents(G, node_id: str) -> list[str]:
    if node_id not in G:
        return []
    return list(G.predecessors(node_id))


def get_dependencies(G, node_id: str) -> list[str]:
    if node_id not in G:
        return []
    return list(G.successors(node_id))


def get_spof_candidates(G) -> list[dict]:
    flagged = [
        {
            "node_id": node,
            "in_degree": G.in_degree(node),
            "spof_candidate": True,
            "spof_source": data.get("spof_source") or "metadata",
        }
        for node, data in G.nodes(data=True)
        if data.get("spof_candidate")
    ]
    if flagged:
        return sorted(flagged, key=lambda item: item["in_degree"], reverse=True)

    ranked = sorted(G.nodes, key=lambda n: G.in_degree(n), reverse=True)
    return [
        {
            "node_id": node,
            "in_degree": G.in_degree(node),
            "spof_candidate": G.in_degree(node) >= 3,
            "spof_source": "derived",
        }
        for node in ranked[:5]
    ]


def get_architecture_overview(G) -> dict:
    by_type = defaultdict(list)
    for node, data in G.nodes(data=True):
        by_type[data.get("node_type") or "service"].append(node)

    edges = [
        {
            "source": source,
            "target": target,
            "type": data.get("edge_type") or "calls",
            "count": data.get("call_count") or 1,
        }
        for source, target, data in G.edges(data=True)
    ]

    return {
        "source": G.graph.get("source") or "unknown",
        "groups": {
            "services": sorted(by_type.get("service", [])),
            "databases": sorted(by_type.get("database", [])),
            "external_apis": sorted(by_type.get("external_api", [])),
        },
        "spof_candidates": get_spof_candidates(G),
        "call_edges": edges,
        "metadata": dict(G.graph.get("metadata") or {}),
        "notes": [
            "Edges mean dependency direction: from depends on to "
            "(caller -> callee, querier -> database).",
            "Node types come from the architecture scanner.",
            "SPOF candidates are human-flagged or high in-degree hubs.",
        ],
    }


def _execute_tool(G, flows: dict | None, name: str, arguments: dict):
    if name == "get_architecture_overview":
        return get_architecture_overview(G)
    if name == "get_dependents":
        return get_dependents(G, arguments.get("node_id", ""))
    if name == "get_dependencies":
        return get_dependencies(G, arguments.get("node_id", ""))
    if name == "get_spof_candidates":
        return get_spof_candidates(G)
    if flows is None:
        return {"error": "Request-flow data is unavailable"}
    if name == "get_request_flow":
        return get_flow(flows, arguments.get("flow_id", "")) or {
            "error": "Flow not found"
        }
    if name == "get_request_flow_step":
        flow = get_flow(flows, arguments.get("flow_id", ""))
        if not flow:
            return {"error": "Flow not found"}
        return get_step(flow, arguments.get("step_id", "")) or {
            "error": "Step not found"
        }
    if name == "get_flows_for_service":
        return get_flows_for_service(flows, arguments.get("service", ""))
    if name == "get_request_flow_glossary_term":
        return get_glossary_term(flows, arguments.get("term", "")) or {
            "error": "Glossary term not found"
        }
    return {"error": f"Unknown tool: {name}"}


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


def _chat_system_prompt(G) -> str:
    services = ", ".join(sorted(G.nodes))
    return (
        "You are Ripple, an architecture dependency-graph analyst.\n"
        "Each user message is a brand-new standalone question. You have no "
        "memory of prior turns, so never ask follow-up questions, never end "
        "with a question, and never ask the user to confirm or continue.\n"
        "Write in plain sentences only. Do not use markdown: no asterisks, "
        "no bold, no italics, no hashtags, no bullet markers like -, *, or #.\n"
        "Give a complete, self-contained answer in one reply.\n"
        "For architecture / overview / 'explain the system' questions, call "
        "get_architecture_overview first, then summarize services, databases, "
        "external systems, and key flows in plain language.\n"
        "For dependency, dependents, blast-radius, or SPOF questions, call "
        "the matching tool before answering.\n"
        f"Known nodes: {services}."
    )


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
        "static inference rather than runtime proof.\n"
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
    if context.term:
        item = get_glossary_term(flows, context.term)
        if item:
            return f"{item['term']}: {item['definition']}"
        return f"The glossary has no definition for '{context.term}'."

    if not context.flow_id:
        return (
            "Offline mode needs a selected flow_id to explain a request flow. "
            f"The artifact contains {len(flows['flows'])} flows."
        )
    flow = get_flow(flows, context.flow_id)
    if not flow:
        return f"The selected request flow '{context.flow_id}' was not found."

    if context.step_id is not None:
        step = get_step(flow, context.step_id)
        if not step:
            return (
                f"The selected step '{context.step_id}' was not found in "
                f"flow '{context.flow_id}'."
            )
        evidence = " ".join(step["evidence"])
        return (
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
        return (
            f"{story['summary']} {facts}".strip()
            + " This comes from static source evidence and team notes, not a runtime trace."
        )

    descriptions = []
    for step in flow["steps"]:
        descriptions.append(
            f"{step['id']} {step['kind']} '{step['label']}' at "
            f"{step['file']} line {step['line']}"
        )
    return (
        f"Flow '{flow['id']}' starts from {flow['trigger']['label']} in "
        f"service {flow['service']}. The evidence-backed order is: "
        + "; then ".join(descriptions)
        + f". Overall confidence is {flow.get('confidence', 'unknown')}. "
        "This is a static path inferred from source evidence, not a runtime trace."
    )


def _offline_architecture_explanation(G) -> str:
    overview = get_architecture_overview(G)
    groups = overview["groups"]
    return (
        "The language-model provider is unavailable, so this is a deterministic "
        "graph summary. Services: "
        + (", ".join(groups["services"]) or "none")
        + ". Databases: "
        + (", ".join(groups["databases"]) or "none")
        + ". External systems: "
        + (", ".join(groups["external_apis"]) or "none")
        + f". The graph contains {len(overview['call_edges'])} dependency edges."
    )


def _mermaid_id(node_id: str) -> str:
    return "".join(ch if ch.isalnum() else "_" for ch in node_id)


def _short_label(node_id: str) -> str:
    if "." in node_id:
        return node_id.split(".")[-1]
    return node_id


def _graph_to_mermaid(G) -> str:
    lines = ["flowchart LR"]
    services = []
    databases = []
    externals = []

    for node, data in G.nodes(data=True):
        node_type = data.get("node_type") or "service"
        safe_id = _mermaid_id(node)
        label = _short_label(node)
        entries = data.get("entry_points_count") or 0
        if node_type == "database":
            databases.append((safe_id, f'{safe_id}[("{label}")]'))
        elif node_type == "external_api":
            externals.append((safe_id, f'{safe_id}["{label}"]'))
        else:
            services.append(
                (safe_id, f'{safe_id}["{label}<br/>{entries} entry points"]')
            )

    if services:
        lines.append("  subgraph service [Services]")
        lines.extend(f"    {line}" for _, line in services)
        lines.append("  end")
    if databases:
        lines.append("  subgraph database [Databases]")
        lines.extend(f"    {line}" for _, line in databases)
        lines.append("  end")
    if externals:
        lines.append("  subgraph externalapi [External systems]")
        lines.extend(f"    {line}" for _, line in externals)
        lines.append("  end")

    for source, target, data in G.edges(data=True):
        edge_type = data.get("edge_type") or "calls"
        count = data.get("call_count") or 1
        confidence = data.get("confidence") or "medium"
        connector = "-.->" if edge_type == "imports" else "-->"
        lines.append(
            f"  {_mermaid_id(source)} {connector}|"
            f'"{edge_type} ×{count} ({confidence})"| {_mermaid_id(target)}'
        )

    lines.extend(
        [
            "  classDef service fill:#cfe8ff,stroke:#1d6fb8,color:#0b2a45",
            "  classDef database fill:#d8f3e7,stroke:#1f8a5b,color:#0b3b2a",
            "  classDef external fill:#efe8dc,stroke:#8a734b,color:#3a2f1c",
            "  classDef danger fill:#f8d4d0,stroke:#c2410c,color:#7c2d12,stroke-width:3px",
        ]
    )

    for node, data in G.nodes(data=True):
        safe_id = _mermaid_id(node)
        if data.get("spof_candidate"):
            class_name = "danger"
        else:
            node_type = data.get("node_type") or "service"
            class_name = {
                "database": "database",
                "external_api": "external",
            }.get(node_type, "service")
        lines.append(f"  class {safe_id} {class_name}")

    return "\n".join(lines)


def _load_mermaid(G) -> str:
    mermaid_path = _resolve_path("MERMAID_PATH", _snapshot_file("architecture.mmd"))
    if mermaid_path.is_file() and G.graph.get("source") == "architecture":
        return mermaid_path.read_text().strip()
    return _graph_to_mermaid(G)


@app.get("/")
def root():
    return {
        "service": "ripple",
        "endpoints": [
            "/graph",
            "/graph/mermaid",
            "/entry-points",
            "/entry-points/{service_id}",
            "/request-flows",
            "/request-flows/{flow_id}",
            "/request-flows/{flow_id}/mermaid",
            "/knowledge",
            "/team-diagrams",
            "/snapshots",
            "/snapshots/active",
            "/simulate/failure/{node_id}",
            "/chat",
            "/chat/status",
            "/docs",
        ],
    }


@app.get("/graph")
def get_graph():
    G = _load_graph()
    return graph_to_json(G)


@app.get("/graph/mermaid")
def get_graph_mermaid():
    G = _load_graph()
    return {"mermaid": _load_mermaid(G)}


@app.get("/entry-points")
def get_all_entry_points():
    return _load_entry_points()


@app.get("/entry-points/{service_id}")
def get_service_entry_points(service_id: str):
    data = _load_entry_points()
    if service_id not in data:
        raise HTTPException(
            status_code=404,
            detail=f"No entry points found for '{service_id}'",
        )
    return data[service_id]


@app.get("/request-flows")
def get_request_flow_catalog():
    return request_flow_catalog(_load_request_flows())


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


@app.get("/team-diagrams")
def get_team_diagrams():
    path = _resolve_path("TEAM_DIAGRAMS_PATH", _snapshot_file("team-diagrams.json"))
    if not path.is_file():
        return {"diagrams": [], "docs": []}
    return json.loads(path.read_text(encoding="utf-8"))


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
    if not SNAPSHOT_SLUG.match(slug) or not (_snapshots_dir() / slug / "graph.json").is_file():
        raise HTTPException(status_code=404, detail=f"No scanned snapshot named '{slug}'")
    _active_snapshot = slug
    return get_snapshots()


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


@app.post("/simulate/failure/{node_id}")
def simulate_failure(node_id: str):
    G = _load_graph()

    if node_id not in G:
        raise HTTPException(
            status_code=404,
            detail=f"Node '{node_id}' not found in the graph",
        )

    visited = {node_id}
    queue = deque([node_id])
    waves = [{"hop": 0, "nodes": [node_id]}]
    hop = 0

    while queue:
        hop += 1
        layer = []
        for _ in range(len(queue)):
            current = queue.popleft()
            for predecessor in G.predecessors(current):
                if predecessor not in visited:
                    visited.add(predecessor)
                    queue.append(predecessor)
                    layer.append(predecessor)
        if layer:
            waves.append({"hop": hop, "nodes": layer})

    return {"failed_node": node_id, "waves": waves}


@app.get("/chat/status")
def chat_status():
    return _provider_status()


@app.post("/chat")
def chat(body: ChatRequest):
    G = _load_graph()
    context = body.context or ChatContext()
    flows = _load_request_flows() if context.type == "flow" else None
    provider = _openai_client()
    if provider is None:
        response = (
            _offline_flow_explanation(flows, context)
            if flows is not None
            else _offline_architecture_explanation(G)
        )
        return {"response": response, "mode": "offline"}
    client, model = provider

    messages = [
        {
            "role": "system",
            "content": (
                _flow_chat_prompt(context, flows)
                if context.type == "flow"
                else _chat_system_prompt(G)
            ),
        },
        {"role": "user", "content": body.message},
    ]

    try:
        status = _provider_status()
        for _ in range(3):
            request: dict = {"model": model, "messages": messages}
            if context.type != "flow":
                request["tools"] = CHAT_TOOLS
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
            choice = completion.choices[0].message
            tool_calls = choice.tool_calls or []

            if not tool_calls:
                return {
                    "response": _strip_markdown(choice.content or ""),
                    "mode": "online",
                }

            messages.append(choice.model_dump(exclude_none=True))
            for tool_call in tool_calls:
                raw_args = tool_call.function.arguments or "{}"
                try:
                    arguments = json.loads(raw_args)
                except json.JSONDecodeError:
                    arguments = {}
                result = _execute_tool(
                    G, flows, tool_call.function.name, arguments
                )
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": json.dumps(result),
                    }
                )

        return {
            "response": (
                "I looked up the graph data but could not produce a final "
                "answer. Please try rephrasing your question."
            ),
            "mode": "online",
        }
    except HTTPException:
        raise
    except Exception as exc:
        response = (
            _offline_flow_explanation(flows, context)
            if flows is not None
            else _offline_architecture_explanation(G)
        )
        return {
            "response": (
                f"{response} The configured language model did not respond, "
                "so Ripple used its evidence-only fallback."
            ),
            "mode": "offline",
            "provider_error": type(exc).__name__,
        }
