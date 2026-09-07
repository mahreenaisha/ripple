import json
import random

SERVICES = [
    "api-gateway",
    "auth-service",
    "payments-service",
    "inventory-service",
    "notifications-service",
    "billing-service",
    "user-service",
    "order-service",
    "shipping-service",
    "email-service",
    "analytics-service",
    "search-service",
]

# Directed call edges (source -> target). Hubs like auth-service and
# payments-service receive many incoming edges. The last three edges form
# a cycle: order-service -> billing-service -> inventory-service -> order-service.
CALL_EDGES = [
    ("api-gateway", "auth-service"),
    ("api-gateway", "user-service"),
    ("api-gateway", "order-service"),
    ("api-gateway", "search-service"),
    ("api-gateway", "payments-service"),
    ("user-service", "auth-service"),
    ("order-service", "auth-service"),
    ("order-service", "payments-service"),
    ("order-service", "inventory-service"),
    ("order-service", "shipping-service"),
    ("order-service", "notifications-service"),
    ("billing-service", "auth-service"),
    ("billing-service", "payments-service"),
    ("billing-service", "user-service"),
    ("payments-service", "auth-service"),
    ("payments-service", "billing-service"),
    ("inventory-service", "auth-service"),
    ("shipping-service", "auth-service"),
    ("shipping-service", "inventory-service"),
    ("shipping-service", "notifications-service"),
    ("notifications-service", "email-service"),
    ("notifications-service", "auth-service"),
    ("email-service", "auth-service"),
    ("search-service", "auth-service"),
    ("search-service", "inventory-service"),
    ("analytics-service", "order-service"),
    ("analytics-service", "user-service"),
    ("analytics-service", "payments-service"),
    ("user-service", "analytics-service"),
    # Intentional circular dependency
    ("order-service", "billing-service"),
    ("billing-service", "inventory-service"),
    ("inventory-service", "order-service"),
]


def make_call_record(source, target):
    hub_targets = {"auth-service", "payments-service"}
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
