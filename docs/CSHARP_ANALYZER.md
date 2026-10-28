# C# request-flow analyzer

Ripple's structural request-flow evidence is produced by a .NET 10 analyzer
using Roslyn 5.9. The Node scanner remains the stable command-line entry point
and writes the existing `request-flows.json` and `snapshot.json` artifacts.

## Analysis modes

**Study without build** creates a Roslyn `AdhocWorkspace` from local `.cs`
files and runtime framework references. It does not invoke restore, MSBuild, or
a build, and it does not write to the scanned repository. Roslyn syntax and
available semantic symbols discover routes, overload-aware local calls, and
source relationships. Missing external/generated/project-system information
ends in low-confidence inference limits. The artifact always records
`analysis.mode = "study"` and `completeness = "partial"`.

**Verified project analysis** uses `MSBuildWorkspace` to load projects and
project references. Roslyn semantic models and `IOperation` resolve framework
bindings, method calls, overloads, source implementations, and supported
built-in DI registrations. A project-load failure prevents snapshot promotion.

Both modes traverse resolved calls until a supported database, queue, HTTP
client, or other process boundary. Node then adds deterministic documentation,
metric, setting, and ownership summaries without changing the structural
graph.

The LLM is not involved in scanning, path assembly, ranking, or Mermaid
generation.

## Evidence and uncertainty

Verified high confidence requires a direct framework binding, method symbol, or
explicit DI registration. Medium confidence is used for documented conventions
and for a single source implementation when no supported DI registration
selects it. Study-mode steps are capped at medium confidence, and unresolved
source-only calls are low confidence.

Ripple emits an `inference-limit` step and warning when Roslyn knows a call
symbol but static evidence cannot select its runtime implementation. Reflection,
`dynamic`, runtime plugins, external registrations, unavailable generated
sources, and runtime branches are not claimed as verified paths.

## Running

Install the .NET 10 SDK in the same environment that runs Ripple, then run:

```bash
node scanner/scan-repo.js /path/to/csharp-repository --mode study
```

If `dotnet` is not on `PATH`, set `RIPPLE_DOTNET` to the executable. The Node
bridge builds the analyzer in Release mode when its source changes.

The local UI provides both modes from the `+` button beside the repository
selector. Study mode is the default and disables package restore. Verified mode
lets the user choose a solution and optionally run `dotnet restore`, which may
create or update `obj/` content in the selected repository.

Scanning and restoration are staged. Ripple does not replace the active
snapshot when restore fails, private NuGet authentication is unavailable, the
user cancels, or Roslyn emits a `project-load-failed` warning. Configure private
feed credentials for the backend environment before retrying.

Windows and WSL installations are separate. When Ripple runs in WSL, install
.NET 10 inside WSL even if `dotnet` is already available in PowerShell.
Prefer a WSL-local clone restored by that SDK. Windows-generated `obj` assets
can contain fallback package paths such as `C:\Program Files...` that Linux
MSBuild cannot resolve; Ripple surfaces this as `project-load-failed` rather
than silently falling back to text matching.
