from backend.cache import ExplanationCache


def key(**changes: str) -> str:
    values = {
        "repository_id": "repo",
        "commit": "abc",
        "folder": "server",
        "folder_state_hash": "state",
        "evidence_hash": "evidence",
        "model": "qwen2.5-coder:7b",
        "prompt_version": "folder-v1",
        "mode": "full",
    }
    values.update(changes)
    return ExplanationCache.make_key(**values)


def test_every_provenance_input_invalidates_cache_key() -> None:
    original = key()
    assert key(repository_id="another") != original
    assert key(commit="def") != original
    assert key(folder="utilities") != original
    assert key(folder_state_hash="changed") != original
    assert key(evidence_hash="changed") != original
    assert key(model="another-model") != original
    assert key(prompt_version="folder-v2") != original
    assert key(mode="preview") != original

