# Ripple

Ripple is an evidence-backed ASP.NET Core Request Flow Explorer. Point it at a
C# repository to trace HTTP and queue triggers through handlers and calls to
databases, queues, and external systems.

Every step links to a source file and line, records its confidence, and explains
the evidence used by the deterministic scanner. Ripple records the scanned Git
commit so engineers know exactly which source revision a flow describes.

> Ripple currently uses static repository analysis. It does not ingest
> OpenTelemetry or other runtime telemetry, and a detected path is not proof of
> runtime behavior.

## Product focus

Request flows are the only active product surface on `main`. Architecture maps,
change impact, and the guided repository explorer remain in Git history and on
the `archive/full-ripple` branch, but they are intentionally not loaded by the
focused application.

Ripple provides one place to:

- browse and filter detected request flows;
- inspect every step and its source evidence;
- compare alternate branches and meaningful system boundaries;
- render a compact sequence diagram;
- attach verified team knowledge; and
- ask questions constrained to the selected flow.

## Features

### Request Flow Explorer

Browse API and queue-triggered flows. Each step includes its source file,
line number, evidence, and confidence. Mermaid sequence diagrams provide a
compact view of the selected path.

### Repository snapshots

Switch between any locally scanned repositories from the UI. A focused snapshot
contains request flows plus source commit, branch, remote, and scan time.

### Grounded flow guide

Ask questions about the selected flow or step. Answers are constrained to scan
evidence and attached team knowledge. Without an LLM provider, Ripple uses a
deterministic evidence-only response.

### Team knowledge

Add verified facts sourced from files in the scanned repository. Ripple checks
the referenced path and line before storing the fact and attaches applicable
knowledge to request flows.

## Technology

- Angular, TypeScript, and SCSS
- Mermaid.js for request-flow sequence diagrams
- Roslyn syntax trees, semantic models, `IOperation`, and `MSBuildWorkspace`
- Node.js for scanner orchestration and deterministic story enrichment
- Python and FastAPI for the API
- Ollama or OpenRouter for optional LLM responses
- Git metadata, JSON, and YAML for traceable snapshots and team knowledge

OpenTelemetry is not part of the current implementation.

## Repository layout

```text
backend/                 FastAPI API, flow chat, and team knowledge
frontend/                Angular application
scanner/                 Deterministic request-flow scanner
snapshots/<repo>/        Generated request-flow artifacts per repository
knowledge/<repo>.yaml    Human-maintained, verified team knowledge
docs/                    Release criteria and engineering notes
```

## Prerequisites

- Node.js 20 or newer
- .NET 10 SDK
- npm
- Python 3 with `venv`
- Git
- Optional: Ollama for fully local LLM responses

## Scan a repository

From the Ripple root:

```bash
node scanner/scan-repo.js /path/to/csharp-repository
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
request-flows.json
snapshot.json
```

Re-run the same command to refresh the snapshot after the source repository
changes.

The browser does not receive unrestricted access to local files. The Node.js
scanner reads the repository using the permissions of the local process and
writes sanitized snapshot artifacts that the web app loads through FastAPI.

## Run the application

### One-click runner

On Linux, WSL, or macOS, run:

```bash
./run-ripple.sh
```

The script creates missing Python and frontend dependencies, starts both
application services, waits for them to become ready, and opens
`http://localhost:4200` in Google Chrome. Ollama is optional and is not started
automatically.
Keep its terminal open while using Ripple; press `Ctrl+C` to stop both services.
Logs are written to `.ripple-run/`.

If Chrome is installed in a non-standard location, provide it explicitly:

```bash
CHROME_PATH="/path/to/chrome" ./run-ripple.sh
```

To start without opening a browser:

```bash
./run-ripple.sh --no-browser
```

On native Windows, use two PowerShell terminals and follow the backend and
frontend commands below. The scanner itself is cross-platform:

```powershell
node scanner/scan-repo.js C:\path\to\csharp-repository
```

Set `RIPPLE_DOTNET` if `dotnet` is not on `PATH`.
When Ripple runs in WSL, .NET must be installed inside WSL; a Windows .NET
installation is a separate environment.

For reliable `MSBuildWorkspace` results, scan a WSL-local clone that has been
restored with the WSL .NET SDK. Reusing a Windows build tree through `/mnt/c`
can leave `obj/project.assets.json` files containing Windows-only package paths;
Ripple reports those as `project-load-failed` warnings and the snapshot must not
be treated as complete.

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

Every directory under `snapshots/` containing `request-flows.json` appears in the
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

## Validation

Run the complete backend, frontend, and production-build verification:

```bash
./test-all.sh
```

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

- **High:** direct Roslyn symbol, framework attribute, or explicit DI binding.
- **Medium:** a compiler-resolved convention or a unique source implementation
  without an explicit DI registration.

Confidence is not a measure of code quality, service availability, or runtime
reliability.

## Current limitations

- Static analysis can miss framework-generated or dynamically configured routes.
- Reflection, `dynamic`, generated code, and runtime-only DI decisions are marked
  unresolved rather than assigned a guessed target.
- Runtime-only dependencies are invisible until runtime telemetry is added.
- Generated clients and code not present at scan time cannot be analyzed.
- LLM answers are limited by the available scan evidence and model capability.

Use Ripple as a discovery aid, not proof of runtime behavior. Verify
medium-confidence findings before making production decisions. The release gate
for the focused product is documented in `docs/REQUEST_FLOW_RELEASE.md`.