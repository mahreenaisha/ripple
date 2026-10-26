# Request Flow release contract

Ripple remains a request-flow-only product until every required gate below
passes. A green build is necessary, but it is not enough by itself.

## Correctness

- Every displayed step has an existing repository-relative file, a positive
  line number, non-empty evidence, and an explicit confidence.
- Repeated scans of the same commit produce byte-equivalent request-flow data
  except for documented scan timestamps.
- Supported framework fixtures detect all directly registered API, CLI, and
  queue triggers.
- The curated benchmark set maintains at least 90% precision for reported
  trigger-to-boundary paths. Recall is reported separately; a missing flow is
  preferable to a fabricated path.
- Evidence from one flow never appears in another selected flow or answer.
- Dynamic or unresolved behavior ends in an explicit inference-limit step or a
  warning instead of an invented target.

## Supported baseline

The first trusted release supports the framework patterns represented by the
scanner fixtures:

- Express and FastAPI route bindings;
- ASP.NET controller routes and interface injection;
- evidence-backed C# queue discriminator and handler bindings; and
- CLI triggers already covered by scanner tests.

Other frameworks are unsupported until they have both a positive fixture and a
near-miss fixture that proves the scanner does not overmatch.

## Failure behavior

- An unreadable repository, malformed artifact, missing snapshot, invalid
  repository selection, or unavailable API produces a specific actionable
  message.
- Empty repositories and repositories with no supported triggers produce a
  valid empty artifact and UI state.
- The flow explorer works without an LLM provider.
- LLM timeouts or provider failures fall back to evidence-only output without
  blocking deterministic scanning or flow browsing.

## Performance budgets

Measure on the documented reference laptop with a warm filesystem cache:

- focused scan: at most 10 seconds for the small fixture suite;
- focused scan: at most 60 seconds for a 100,000-file repository;
- `GET /request-flows`: p95 under 500 ms for 500 flows;
- initial flow list render: under 1 second for 500 flows; and
- switching between already-scanned repositories: under 1 second.

Record repository size, commit, hardware, operating system, and command with
every benchmark result. A budget change requires a documented reason.

## Portability and setup

- Scanner, backend, frontend tests, and production build pass on Linux/WSL,
  native Windows, and macOS.
- Paths containing spaces and non-ASCII characters are included in scanner
  fixtures.
- The documented setup works from a clean clone without DeviceAS, TenancyAS, or
  any developer-specific directory.
- No API key or Ollama installation is required for the default experience.

## Usability

A new engineer must be able to complete these tasks without source-code help:

1. scan a repository of their choice;
2. select it in Ripple;
3. find a known request trigger;
4. trace it to a boundary and open its source evidence;
5. recognize uncertainty or an unsupported path; and
6. ask an evidence-grounded question about a selected step.

Test with at least five representative users. All six tasks must succeed for
four of five users; every failure becomes a tracked issue before release.

## Required automated checks

Run from the repository root:

```bash
./test-all.sh
```

This command must run scanner tests, backend tests, frontend tests, and the
production frontend build. Release changes are developed on short-lived
`request-flow/*` branches and merged to `main` only after these gates pass.
