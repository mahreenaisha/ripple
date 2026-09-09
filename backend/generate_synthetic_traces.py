import json
import random

# Layered topology (source -> target means caller -> callee):
#   edge        — entry points; nothing calls them (in-degree 0)
#   mid-tier    — business logic; called by edge, calls shared infra
#   shared infra — SPOFs with high in-degree
#   leaves      — few callers, so failures have minimal blast radius
SERVICES = [
    # frontend / edge
    "web-app",
    "mobile-app",
    "api-gateway",
    # business logic mid-tier
    "order-service",
    "payments-service",
    "inventory-service",
    "user-service",
    # shared infra (SPOFs)
    "auth-service",
    "database-service",
    # leaves (low in-degree)
    "email-service",
    "analytics-service",
    "notifications-service",
]

# Sparse edges: mid-tier services call only 1–2 infra targets, not a full mesh.
# The last three edges form a cycle:
#   order-service -> payments-service -> inventory-service -> order-service
CALL_EDGES = [
    # Edge -> mid-tier (each edge fans into a subset of mid-tier)
    ("web-app", "user-service"),
    ("web-app", "order-service"),
    ("mobile-app", "user-service"),
    ("mobile-app", "order-service"),
    ("api-gateway", "order-service"),
    ("api-gateway", "payments-service"),
    ("api-gateway", "inventory-service"),
    ("api-gateway", "user-service"),
    # Edge -> auth (login / token checks boost auth in-degree)
    ("web-app", "auth-service"),
    ("mobile-app", "auth-service"),
    ("api-gateway", "auth-service"),
    # Mid-tier -> shared infra (1–2 each; not every mid-tier hits both)
    ("order-service", "auth-service"),
    ("order-service", "database-service"),
    ("payments-service", "auth-service"),
    ("payments-service", "database-service"),
    ("inventory-service", "database-service"),
    ("user-service", "auth-service"),
    # Mid-tier -> leaves (hang off user-service, not the order cycle,
    # so leaf failures stay small and don't fan through the SPOF cycle)
    ("user-service", "analytics-service"),
    ("user-service", "notifications-service"),
    ("notifications-service", "email-service"),
    # Leaves may touch infra lightly
    ("email-service", "database-service"),
    ("analytics-service", "database-service"),
    # Intentional circular dependency among mid-tier
    ("order-service", "payments-service"),
    ("payments-service", "inventory-service"),
    ("inventory-service", "order-service"),
]


def make_call_record(source, target):
    hub_targets = {"auth-service", "database-service"}
    if target in hub_targets:
        call_count = random.randint(800, 5000)
        avg_latency_ms = round(random.uniform(8.0, 45.0), 2)
        error_rate = round(random.uniform(0.001, 0.04), 4)
    else:
        call_count = random.randint(40, 900)
        avg_latency_ms = round(random.uniform(12.0, 180.0), 2)
        error_rate = round(random.uniform(0.0, 0.08), 4)

    return {
        "source": source,
        "target": target,
        "call_count": call_count,
        "avg_latency_ms": avg_latency_ms,
        "error_rate": error_rate,
    }


def generate_traces():
    return [make_call_record(source, target) for source, target in CALL_EDGES]


def write_traces(path, traces):
    with open(path, "w") as f:
        json.dump(traces, f, indent=2)
        f.write("\n")


if __name__ == "__main__":
    random.seed(42)
    traces = generate_traces()
    write_traces("synthetic_traces.json", traces)
    print(f"Wrote {len(traces)} call records to synthetic_traces.json")
