import json
from collections import deque

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from graph_builder import build_graph, graph_to_json

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _load_graph():
    with open("synthetic_traces.json") as f:
        traces = json.load(f)
    return build_graph(traces)


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
