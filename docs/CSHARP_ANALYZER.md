# C# request-flow analyzer

Ripple's structural request-flow evidence is produced by a .NET 10 analyzer
using Roslyn 5.9. The Node scanner remains the stable command-line entry point
and writes the `request-flows.json`, `architecture-graph.json`, and
`snapshot.json` artifacts.

## Source-only analysis

Ripple creates a Roslyn `AdhocWorkspace` from local `.cs` files and runtime
framework references. It does not invoke restore, MSBuild, or a build, and it
does not write to the scanned repository. Roslyn syntax and available semantic
symbols discover routes, overload-aware local calls, and source relationships.
Missing external, generated, or project-system information ends in
low-confidence inference limits. The artifact always records
`analysis.mode = "study"` and `completeness = "partial"`.

The analyzer traverses resolved calls until a supported database, queue, HTTP
client, or other process boundary. Node then adds deterministic documentation,
metric, setting, and ownership summaries without changing the structural
graph.

The LLM is not involved in scanning, path assembly, ranking, or Mermaid
generation.

## Evidence and uncertainty

Source-only steps are capped at medium confidence, and unresolved calls are low
confidence.

Ripple emits an `inference-limit` step and warning when Roslyn knows a call
symbol but static evidence cannot select its runtime implementation. Reflection,
`dynamic`, runtime plugins, external registrations, unavailable generated
sources, and runtime branches are not claimed as verified paths.

## Architecture Map

`architecture-graph.json` covers every non-test project, not only the code that
request flows reach. It shows runnable services, the libraries they reference,
and the databases, queues, and external systems their code uses. Each
connection keeps the evidence behind it and is tiered by its strongest item:

- **Call**: code calls a known client type, such as `IAmazonSQS.SendMessageAsync`.
- **Wiring**: the project registers, injects, or configures a client, but Ripple
  found no call in that project.
- **Declared only**: a package reference or generated API client declares the
  dependency.

A connection is `direct` when Roslyn sees the client type and its namespace at
that line, or when a package, configuration entry, generated client, or project
reference declares it. Ripple infers the technology behind an in-repo wrapper,
such as a repository interface, only when the wrapper's name or the namespaces
imported by every file that declares it point to that one technology.
Registrations matched by name count only when the receiver is a
dependency-injection container. These connections are marked `inferred`.

## Running

Install the .NET 10 SDK in the same environment that runs Ripple, then run:

```bash
node scanner/scan-repo.js /path/to/csharp-repository
```

If `dotnet` is not on `PATH`, set `RIPPLE_DOTNET` to the executable. The Node
bridge builds the analyzer in Release mode when its source changes.

The local UI provides the same workflow from the `+` button beside the
repository selector. It checks the path and SDK, then runs the source-only scan.

Scanning is staged. Ripple does not replace the active snapshot when analysis
fails or the user cancels.

Windows and WSL installations are separate. When Ripple runs in WSL, install
.NET 10 inside WSL even if `dotnet` is already available in PowerShell.
Prefer a WSL-local clone so file access stays fast and paths remain native to
the environment running Ripple.
