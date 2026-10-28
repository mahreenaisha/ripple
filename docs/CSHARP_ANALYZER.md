# C# request-flow analyzer

Ripple's structural request-flow evidence is produced by a .NET 10 analyzer
using Roslyn 5.9. The Node scanner remains the stable command-line entry point
and writes the existing `request-flows.json` and `snapshot.json` artifacts.

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
