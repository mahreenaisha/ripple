# Ripple

Ripple turns evolving source repositories into evidence-backed architecture maps.
It scans code and configuration to identify executable services, API and message
entry points, request flows, databases, queues, external systems, and
dependencies. Every snapshot records the source commit, branch, and scan time so
engineers can see how current the architecture information is.

Unlike a manually maintained diagram, Ripple can be regenerated locally or in CI
whenever a repository changes. Its findings link back to source files and line
numbers and clearly distinguish direct evidence from lower-confidence static
inference.

> Ripple currently uses static repository analysis. It does not ingest
> OpenTelemetry or other runtime telemetry, and a detected path is not proof of
> runtime behavior.

## Why Ripple

Enterprise systems change faster than their architecture documentation. Static
diagrams become stale, while important implementation details remain scattered
across code, configuration, and team knowledge.

Ripple provides one place to:

- explore the current service and dependency map;
- trace requests from an entry point toward meaningful system boundaries;
- inspect architecture tied to a specific repository commit;
- evaluate direct and transitive change impact;
- ask architecture questions using grounded scan evidence; and
- attach verified team knowledge that cannot be inferred safely from code.

## Features

### Interactive architecture map

Explore services, databases, message queues, external systems, and their
dependency direction. Select a node to inspect its entry points and evidence.

### Request Flow Explorer

Browse API, CLI, and queue-triggered flows. Each step includes its source file,
line number, evidence, and confidence. Mermaid sequence diagrams provide a
compact view of the selected path.

### Architecture snapshots

Switch between scanned repositories from the UI. A snapshot includes its source
commit, branch, remote, scan time, architecture graph, request flows, generated
diagrams, and discovered team documentation.

### Change Impact

Inspect which components directly or transitively depend on a selected service
or system. This is static dependency impact analysis, not infrastructure-failure
prediction.

### LLM architecture querying

Ask plain-language questions about the active architecture or selected request
flow. Flow answers are constrained to scanner evidence and attached team
knowledge. Ripple supports a local Ollama model or an OpenRouter model through
an OpenAI-compatible client.

### Team knowledge

Add verified facts sourced from files in the scanned repository. Ripple checks
the referenced path and line before storing the fact and attaches applicable
knowledge to request flows.

## Technology

- Angular, TypeScript, and SCSS
- Cytoscape.js for interactive graph visualization
- Mermaid.js and ELK for architecture and request-flow diagrams
- Node.js for deterministic repository scanning
- Python, FastAPI, and NetworkX for the API and graph operations
- Ollama or OpenRouter for optional LLM responses
- Git metadata, JSON, and YAML for traceable snapshots and team knowledge

OpenTelemetry is not part of the current implementation.

## Repository layout

```text
backend/                 FastAPI API, graph operations, chat, and knowledge
frontend/                Angular application
scanner/                 Static repository scanner and diagram generator
snapshots/<repo>/        Generated architecture artifacts per repository
knowledge/<repo>.yaml    Human-maintained, verified team knowledge
.github/workflows/       Scheduled and on-demand scanning workflow
```

## Prerequisites

- Node.js 20 or newer
- npm
- Python 3 with `venv`
- Git
- Optional: Ollama for fully local LLM responses

## Scan a repository

From the Ripple root:

```bash
node scanner/scan-repo.js /path/to/repository
```

Ripple infers the display name and writes the result under `snapshots/`. You can
set them explicitly:

```bash
node scanner/scan-repo.js /path/to/repository \
  --out snapshots/example \
  --name Example
```

The generated directory contains:

```text
services.json
entry-points.json
dependencies.json
request-flows.json
graph.json
snapshot.json
metadata.yaml
team-diagrams.json
architecture.mmd
architecture.svg
architecture.html
```

Re-run the same command to refresh the snapshot after the source repository
changes. Human edits in `metadata.yaml` are preserved.

The browser does not receive unrestricted access to local files. The Node.js
scanner reads the repository using the permissions of the local process and
writes sanitized snapshot artifacts that the web app loads through FastAPI.

## Run the application

### Backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

The API and interactive documentation are available at:

- `http://localhost:8000`
- `http://localhost:8000/docs`

### Frontend

In another terminal:

```bash
cd frontend
npm install
npm start
```

Open `http://localhost:4200`.

## Configure the LLM

LLM access is optional. If the configured provider is unavailable, Ripple uses
an evidence-only deterministic fallback.

### Local Ollama

Install Ollama, pull a model, and configure the backend environment:

```bash
ollama pull llama3.2:3b
```

Create `backend/.env`:

```dotenv
LLM_PROVIDER=ollama
OLLAMA_MODEL=llama3.2:3b
OLLAMA_BASE_URL=http://localhost:11434/v1
```

### OpenRouter

```dotenv
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=your-key
OPENROUTER_MODEL=openrouter/free
```

Do not commit `.env` or API keys.

## Select snapshots and local source

Every directory under `snapshots/` containing `graph.json` appears in the
repository dropdown. The backend defaults to `deviceas`; override it with:

```bash
RIPPLE_SNAPSHOT=example uvicorn main:app --reload --port 8000
```

The scanner stores the absolute local repository path in `snapshot.json`. For
team-knowledge file validation, you may override it:

```bash
RIPPLE_REPO_PATH=/path/to/repository \
RIPPLE_SNAPSHOT=example \
uvicorn main:app --reload --port 8000
```

## Continuous scanning

`.github/workflows/ripple-scan.yml` supports:

- weekday scheduled scans;
- manual scans for a repository and ref; and
- `repository_dispatch` scans initiated by a target repository.

Private repositories require a `RIPPLE_TARGET_TOKEN` secret with read access.
The workflow tests the scanner and uploads the generated snapshot as a build
artifact.

## Validation

Run all scanner tests:

```bash
node --test scanner/*.test.js
```

Run backend tests:

```bash
cd backend
./venv/bin/python -m unittest discover -s . -p 'test_*.py' -v
```

Run frontend tests and build:

```bash
cd frontend
npm test -- --watch=false
npm run build
```

## Understanding confidence

Confidence describes the strength of the scanner's static evidence:

- **High:** direct framework binding or uniquely resolved typed relationship.
- **Medium:** conservative inference based on names, types, or nearby calls.

Confidence is not a measure of code quality, service availability, or runtime
reliability.

## Current limitations

- Static analysis can miss framework-generated or dynamically configured routes.
- Similar method names can create incorrect paths across parallel implementations.
- Runtime-only dependencies are invisible until runtime telemetry is added.
- Generated clients and code not present at scan time cannot be analyzed.
- LLM answers are limited by the available scan evidence and model capability.

Use Ripple as an architecture discovery and change-impact aid, and verify
medium-confidence findings before making production decisions.