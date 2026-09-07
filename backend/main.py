import json

from fastapi import FastAPI
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


@app.get("/")
def root():
    return {"service": "ripple", "endpoints": ["/graph", "/docs"]}


@app.get("/graph")
def get_graph():
    with open("synthetic_traces.json") as f:
        traces = json.load(f)
    G = build_graph(traces)
    return graph_to_json(G)
