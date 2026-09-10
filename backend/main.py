import json
import os
from collections import deque

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from pydantic import BaseModel

from graph_builder import build_graph, graph_to_json

load_dotenv()

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    message: str


CHAT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_architecture_overview",
            "description": (
                "Return a full overview of the microservice architecture: "
                "layered groups (edge, mid-tier, infra, leaves), all call "
                "edges, and a short note about the intentional cycle. "
                "Use this for questions like explain the architecture, "
                "describe the system, or how services are organized."
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
                "List services that directly call (depend on) the given node. "
                "These are the node's direct predecessors in the call graph."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "node_id": {
                        "type": "string",
                        "description": "Service node id, e.g. 'auth-service'",
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
                "List services that the given node directly calls. "
                "These are the node's direct successors in the call graph."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "node_id": {
                        "type": "string",
                        "description": "Service node id, e.g. 'order-service'",
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
                "Return the top 3 single points of failure candidates: "
                "nodes with the highest in-degree (most dependents)."
            ),
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
    },
]

# Fixed layer labels for architecture explanations (matches synthetic graph).
ARCHITECTURE_LAYERS = {
    "edge": ["web-app", "mobile-app", "api-gateway"],
    "mid_tier": [
        "order-service",
        "payments-service",
        "inventory-service",
        "user-service",
    ],
    "shared_infra": ["auth-service", "database-service"],
    "leaves": ["email-service", "analytics-service", "notifications-service"],
}


def _load_graph():
    with open("synthetic_traces.json") as f:
        traces = json.load(f)
    return build_graph(traces)


def get_dependents(G, node_id: str) -> list[str]:
    if node_id not in G:
        return []
    return list(G.predecessors(node_id))


def get_dependencies(G, node_id: str) -> list[str]:
    if node_id not in G:
        return []
    return list(G.successors(node_id))


def get_spof_candidates(G) -> list[dict]:
    ranked = sorted(G.nodes, key=lambda n: G.in_degree(n), reverse=True)
    return [
        {"node_id": node, "in_degree": G.in_degree(node)}
        for node in ranked[:3]
    ]


def get_architecture_overview(G) -> dict:
    return {
        "layers": ARCHITECTURE_LAYERS,
        "layer_meanings": {
            "edge": "Frontend/entry services; nothing calls them (in-degree 0).",
            "mid_tier": "Business logic; called by edge, calls shared infra.",
            "shared_infra": "Shared SPOFs with high in-degree (auth, database).",
            "leaves": "Low in-degree helpers; failing them has a small blast radius.",
        },
        "call_edges": [
            {"source": source, "target": target}
            for source, target in G.edges
        ],
        "notes": [
            "Edges mean caller -> callee (source calls target).",
            "There is an intentional cycle: order-service -> payments-service "
            "-> inventory-service -> order-service.",
        ],
    }


def _execute_tool(G, name: str, arguments: dict):
    if name == "get_architecture_overview":
        return get_architecture_overview(G)
    if name == "get_dependents":
        return get_dependents(G, arguments.get("node_id", ""))
    if name == "get_dependencies":
        return get_dependencies(G, arguments.get("node_id", ""))
    if name == "get_spof_candidates":
        return get_spof_candidates(G)
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
        "You are Ripple, a microservice dependency-graph analyst.\n"
        "Each user message is a brand-new standalone question. You have no "
        "memory of prior turns, so never ask follow-up questions, never end "
        "with a question, and never ask the user to confirm or continue.\n"
        "Write in plain sentences only. Do not use markdown: no asterisks, "
        "no bold, no italics, no hashtags, no bullet markers like -, *, or #.\n"
        "Give a complete, self-contained answer in one reply.\n"
        "For architecture / overview / 'explain the system' questions, call "
        "get_architecture_overview first, then summarize the layers and key "
        "call flows in plain language.\n"
        "For dependency, dependents, blast-radius, or SPOF questions, call "
        "the matching tool before answering.\n"
        f"Known services: {services}."
    )


def _openai_client() -> OpenAI:
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=500,
            detail="OPENROUTER_API_KEY is not set",
        )
    return OpenAI(
        base_url="https://openrouter.ai/api/v1",
        api_key=api_key,
    )


def _tech_type(node_id: str) -> str:
    name = node_id.lower()
    if any(token in name for token in ("gateway", "web", "mobile")):
        return "Frontend"
    if any(token in name for token in ("auth", "database", "db")):
        return "Infra"
    return "Service"


def _mermaid_id(node_id: str) -> str:
    return node_id.replace("-", "_")


def _graph_to_mermaid(G) -> str:
    lines = ["graph TD"]
    for node in G.nodes:
        safe_id = _mermaid_id(node)
        lines.append(f'  {safe_id}["{node} ({_tech_type(node)})"]')
    for source, target in G.edges:
        lines.append(f"  {_mermaid_id(source)} --> {_mermaid_id(target)}")
    return "\n".join(lines)


@app.get("/")
def root():
    return {
        "service": "ripple",
        "endpoints": [
            "/graph",
            "/graph/mermaid",
            "/simulate/failure/{node_id}",
            "/chat",
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
    return {"mermaid": _graph_to_mermaid(G)}


@app.post("/simulate/failure/{node_id}")
def simulate_failure(node_id: str):
    G = _load_graph()

    if node_id not in G:
        raise HTTPException(
            status_code=404,
            detail=f"Node '{node_id}' not found in the graph",
        )

    # Edges are source -> target (caller -> callee). If a service fails,
    # its callers are affected, so walk predecessors (reverse direction).
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


@app.post("/chat")
def chat(body: ChatRequest):
    G = _load_graph()
    client = _openai_client()

    messages = [
        {"role": "system", "content": _chat_system_prompt(G)},
        {"role": "user", "content": body.message},
    ]

    try:
        # Allow a couple of tool rounds, then return the final text.
        for _ in range(3):
            completion = client.chat.completions.create(
                model="openrouter/free",
                messages=messages,
                tools=CHAT_TOOLS,
            )
            choice = completion.choices[0].message
            tool_calls = choice.tool_calls or []

            if not tool_calls:
                return {"response": _strip_markdown(choice.content or "")}

            messages.append(choice.model_dump(exclude_none=True))
            for tool_call in tool_calls:
                raw_args = tool_call.function.arguments or "{}"
                try:
                    arguments = json.loads(raw_args)
                except json.JSONDecodeError:
                    arguments = {}
                result = _execute_tool(G, tool_call.function.name, arguments)
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
            )
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"OpenRouter request failed: {exc}",
        ) from exc
