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


@app.get("/")
def root():
    return {
        "service": "ripple",
        "endpoints": ["/graph", "/simulate/failure/{node_id}", "/docs"],
    }


@app.get("/graph")
def get_graph():
    G = _load_graph()
    return graph_to_json(G)


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
