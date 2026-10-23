# Validation report

## Automated result

Validated on 2026-10-23 with:

```bash
./test-all.sh
```

Results:

- Backend: 20 passed
- Angular: 6 passed
- Production Angular build: passed
- DeviceAS-shaped golden inventory: 100% structural precision and 100% structural recall
- Live DeviceAS structural test: passed against `/home/conmais/repos/wcc-deviceas`

The live test in `backend/tests/test_live_deviceas.py` automatically checks the expected `server`, `utilities`, and `infrastructure` roots, analyzes each folder, and verifies that excluded secret files do not enter evidence. Override its location with `RIPPLE_DEVICEAS_PATH` when another developer uses a different clone path.

## What the tests establish

- Repository paths must exist, be readable, and point to Git repositories.
- Traversal outside the selected repository is rejected.
- Secrets and build output are excluded.
- Inventory and evidence selection are deterministic.
- Relevant changes alter the folder state hash; selected-evidence changes alter the evidence hash.
- Commit, state, evidence, model, prompt, folder, repository, and response mode all participate in cache invalidation.
- Ollama receives a native JSON Schema, malformed output gets one corrective retry, and unsupported citation IDs are removed.
- A missing model does not hide deterministic folder facts.
- Repository overview generation is hierarchical.
- The UI covers repository selection, required-path validation, root boxes, lazy hover details, full evidence details, and the configured API base.

## Accuracy boundary

Ripple reports what is statically defined in source files. Deterministic facts and evidence provenance are machine-checkable. Folder purpose and responsibilities are model interpretations until a person familiar with the repository marks them reviewed.

Citation validation proves that the model referred to an excerpt Ripple supplied. It does not prove that the model interpreted that excerpt correctly.

## Interview summary

Ripple is a grounded hierarchical summarization system over a deterministic repository index. A rule-based scanner establishes source facts and chooses bounded, reproducible excerpts. A local code model interprets those excerpts under a strict schema. Ripple verifies evidence provenance, displays uncertainty, caches by source state, and preserves human review as a separate trust signal.

