import networkx as nx


def build_graph(traces: list[dict]) -> nx.DiGraph:
    G = nx.DiGraph()
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
        )
    return G


def graph_to_json(G: nx.DiGraph) -> dict:
    return {
        "nodes": [{"id": node} for node in G.nodes],
        "edges": [
            {
                "source": source,
                "target": target,
                "call_count": data["call_count"],
                "avg_latency_ms": data["avg_latency_ms"],
                "error_rate": data["error_rate"],
            }
            for source, target, data in G.edges(data=True)
        ],
    }
