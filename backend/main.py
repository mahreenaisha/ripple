import json
import os
from collections import defaultdict, deque
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from pydantic import BaseModel

from graph_builder import build_graph, graph_to_json, load_architecture_graph
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
DEFAULT_GRAPH = REPO_ROOT / "deviceas-snapshot" / "graph.json"
DEFAULT_MERMAID = REPO_ROOT / "deviceas-snapshot" / "architecture.mmd"
DEFAULT_ENTRY_POINTS = REPO_ROOT / "deviceas-snapshot" / "entry-points.json"
DEFAULT_REQUEST_FLOWS = REPO_ROOT / "deviceas-snapshot" / "request-flows.json"


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
    graph_path = _resolve_path("GRAPH_PATH", DEFAULT_GRAPH)
    if graph_path.is_file():
        return load_architecture_graph(graph_path)

    synthetic = BACKEND_DIR / "synthetic_traces.json"
    with open(synthetic) as f:
        traces = json.load(f)
    G = build_graph(traces)
    G.graph["source"] = "synthetic"
    return G


def _load_entry_points() -> dict:
    path = _resolve_path("ENTRY_POINTS_PATH", DEFAULT_ENTRY_POINTS)
    if not path.is_file():
        return {}
    return json.loads(path.read_text())


def _load_request_flows() -> dict:
    path = _resolve_path("REQUEST_FLOWS_PATH", DEFAULT_REQUEST_FLOWS)
    try:
        return load_request_flows(path)
    except RequestFlowError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


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
        "You are Ripple. Answer in 2-4 short plain sentences. No markdown, "
        "no lists, no follow-up questions. Use only the evidence below; do "
        "not invent steps. Mention when something is static inference.\n"
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
    mermaid_path = _resolve_path("MERMAID_PATH", DEFAULT_MERMAID)
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
