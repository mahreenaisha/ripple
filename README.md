# Ripple v2

Ripple is a local, evidence-grounded codebase explorer. It turns a repository's root folders into an interactive architecture surface and explains what the source code **defines**—without claiming to prove runtime behavior.

This branch is a clean-slate vertical slice built with Angular, FastAPI, and Ollama (`qwen2.5-coder:7b`).

## What it does

- Registers local Git repositories chosen by the user.
- Builds a deterministic inventory of root files and first-level folders.
- Shows folders as accessible interactive boxes with immediate observed facts.
- Generates a short grounded overview on hover or keyboard focus.
- Opens a full explanation with observed facts, AI interpretation, source evidence, uncertainties, and human review state.
- Caches explanations while invalidating them when code, evidence, model, or prompt changes.
- Keeps source code on the local machine.

## Guided understanding

The current journey intentionally starts with two steps:

1. **Read the repository overview.** Ripple presents the root README as developer-written context with a table of contents, source line ranges, and reading time. Users may skip this recommendation, and missing READMEs are shown as documentation gaps.
2. **Explore the folder structure.** Ripple then presents deterministic root facts and evidence-grounded folder explanations.

Progress is stored locally and keyed by repository source state. A changed commit, README, or root entry creates a fresh journey instead of carrying stale completion forward.

## Run it

Install [Ollama](https://ollama.com/) and the code model once:

```bash
ollama pull qwen2.5-coder:7b
```

Then run:

```bash
./run-ripple.sh
```

The launcher prepares dependencies, starts Ollama when needed, starts FastAPI and Angular, and opens `http://127.0.0.1:4200` in Chrome. Use `./run-ripple.sh --no-browser` to suppress browser launch.

To add DeviceAS, enter its current WSL path in the UI, for example:

```text
/home/conmais/repos/wcc-deviceas
```

Ripple validates that the path exists, is readable, and is a Git repository. Repository selection remains in each API request; there is no server-global "current repository."

## How folder analysis works

1. `backend/repository.py` walks the selected folder using fixed rules.
2. It excludes `.git`, dependencies, generated/build output, binaries, credentials, and `.env` files.
3. It records observable facts: paths, counts, languages, manifests, entry points, commit, and dirty state.
4. It selects a bounded evidence package in a stable order: README files, manifests, entry points, API declarations, public declarations, dependency wiring, configuration, then representative source samples.
5. Every excerpt receives a trusted evidence ID plus its file and line range.
6. `backend/ollama.py` sends the facts and excerpts to Ollama using its native JSON Schema `format` support.
7. Pydantic validates the response. Ripple rejects evidence IDs it did not supply.
8. The UI clearly separates observed facts from model interpretation.

README text is documentation evidence, not verified truth. It supports folder context by default; code declarations support file-specific claims.

## Cache and freshness

The cache key includes:

```text
repository id + commit + folder + folder state hash + evidence hash + model + prompt version + mode
```

- The **folder state hash** hashes each included file's relative path and full content hash, so added, removed, renamed, or changed relevant files invalidate the result.
- The **evidence hash** hashes the exact excerpts supplied to Ollama.
- Model and prompt versions prevent reuse after analysis behavior changes.

The Git commit is provenance, not the only freshness signal. Uncommitted changes are detected by the content hashes.

## Accuracy contract

- Deterministic facts can be checked exactly.
- A validated citation proves that Ollama referred to evidence it received; it does not prove its interpretation is correct.
- Purpose and responsibility statements are interpretations until a knowledgeable person reviews them.
- Ripple describes what is statically defined in the codebase. It does not claim that a route was exercised, a service is healthy, or a code path runs in production.
- If Ollama is unavailable or returns invalid output twice, observed facts remain available and the explanation fails safely.

## Tests

Run backend tests, Angular tests, and a production build:

```bash
./test-all.sh
```

The DeviceAS golden fixture checks structural precision/recall and stable evidence anchors without asserting exact LLM wording. Model calls are mocked in automated tests.

See [the validation report](docs/VALIDATION.md) for the latest result and the live DeviceAS validation boundary.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `RIPPLE_OLLAMA_MODEL` | `qwen2.5-coder:7b` | Local Ollama model |
| `RIPPLE_OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama API |
| `RIPPLE_DATA_DIR` | project `.ripple/` | Repository registry, cache, and review state |
| `RIPPLE_CORS_ORIGINS` | local Angular origins | Allowed UI origins |

Angular calls the configurable relative API base `/api`. Its development proxy targets FastAPI on port 8000, avoiding hardcoded backend URLs throughout components and keeping a future same-origin deployment possible.

## Interview explanation

Ripple is a grounded hierarchical summarization system over a deterministic repository index. Python first establishes what objectively exists and selects bounded, reproducible evidence. A code-focused local model interprets that evidence under a strict schema. Ripple validates provenance, exposes uncertainty, and lets humans approve interpretations. This makes the model an explainability layer over source facts—not an authority that reads an unlimited repository and invents architecture.

