import json
from pathlib import Path

import networkx as nx


def build_graph(traces: list[dict]) -> nx.MultiDiGraph:
    G = nx.MultiDiGraph()
    for record in traces:
        source = record["source"]
        target = record["target"]
        G.add_node(source)
        G.add_node(target)
        G.add_edge(
            source,
            target,
            call_count=record["call_count"],
            avg_latency_ms=record["avg_latency_ms"],
            error_rate=record["error_rate"],
            edge_type="calls",
            confidence="high",
        )
    return G


def load_architecture_graph(path: str | Path) -> nx.MultiDiGraph:
    """Load Module 1 scanner output (nodes/edges with from/to)."""
    data = json.loads(Path(path).read_text())
    G = nx.MultiDiGraph()

    for node in data.get("nodes", []):
        node_id = node["id"]
        metadata = node.get("metadata") or {}
        G.add_node(
            node_id,
            node_type=node.get("type") or "service",
            language=node.get("language"),
            entry_points_count=node.get("entry_points_count") or 0,
            databases=list(node.get("databases") or []),
            dependencies_on=list(node.get("dependencies_on") or []),
            dependents=list(node.get("dependents") or []),
            confidence=node.get("confidence") or "medium",
            spof_candidate=bool(node.get("spof_candidate")),
            spof_source=node.get("spof_source"),
            status=metadata.get("status"),
            owner=metadata.get("owner"),
            gotchas=list(metadata.get("gotchas") or []),
            last_modified=metadata.get("last_modified"),
            lines_of_code=metadata.get("lines_of_code") or 0,
        )

    for edge in data.get("edges", []):
        source = edge.get("from") or edge.get("source")
        target = edge.get("to") or edge.get("target")
        if not source or not target:
            continue
        if source not in G:
            G.add_node(source, node_type="external_api")
        if target not in G:
            G.add_node(target, node_type="external_api")
        count = int(edge.get("count") or edge.get("call_count") or 1)
        G.add_edge(
            source,
            target,
            call_count=count,
            avg_latency_ms=float(edge.get("avg_latency_ms") or 0),
            error_rate=float(edge.get("error_rate") or 0),
            edge_type=edge.get("type") or "calls",
            confidence=edge.get("confidence") or "medium",
        )

    G.graph["source"] = "architecture"
    G.graph["metadata"] = data.get("metadata") or {}
    return G


def graph_to_json(G: nx.MultiDiGraph | nx.DiGraph) -> dict:
    nodes = []
    for node, data in G.nodes(data=True):
        nodes.append(
            {
                "id": node,
                "type": data.get("node_type") or "service",
                "language": data.get("language"),
                "entry_points_count": data.get("entry_points_count") or 0,
                "databases": list(data.get("databases") or []),
                "dependencies_on": list(data.get("dependencies_on") or []),
                "dependents": list(data.get("dependents") or []),
                "confidence": data.get("confidence") or "medium",
                "spof_candidate": bool(data.get("spof_candidate")),
                "spof_source": data.get("spof_source"),
                "status": data.get("status"),
                "owner": data.get("owner"),
                "gotchas": list(data.get("gotchas") or []),
                "last_modified": data.get("last_modified"),
                "lines_of_code": data.get("lines_of_code") or 0,
            }
        )

    edges = []
    for source, target, data in G.edges(data=True):
        edges.append(
            {
                "source": source,
                "target": target,
                "call_count": data.get("call_count") or 1,
                "avg_latency_ms": data.get("avg_latency_ms") or 0,
                "error_rate": data.get("error_rate") or 0,
                "type": data.get("edge_type") or "calls",
                "confidence": data.get("confidence") or "medium",
            }
        )

    return {
        "nodes": nodes,
        "edges": edges,
        "metadata": dict(G.graph.get("metadata") or {}),
        "source": G.graph.get("source") or "synthetic",
    }
