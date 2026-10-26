# C# request-flow analyzer

Ripple's structural request-flow evidence is produced by a .NET 10 analyzer
using Roslyn 5.9. The Node scanner remains the stable command-line entry point
and writes the existing `request-flows.json` and `snapshot.json` artifacts.

## Pipeline

1. `identify-services.js` finds executable C# projects.
2. `MSBuildWorkspace` loads those projects and their project references.
3. Roslyn syntax trees discover controller attributes, minimal APIs, OData
   conventions, and supported queue discriminators.
4. Semantic models and `IOperation` resolve method calls, overloads, source
   implementations, and supported built-in DI registrations.
5. The analyzer traverses the resolved call graph until it reaches a database,
   queue, HTTP client, or other supported process boundary.
6. Node adds deterministic documentation, metric, setting, and ownership
   summaries without changing the structural graph.

The LLM is not involved in scanning, path assembly, ranking, or Mermaid
generation.

## Evidence and uncertainty

High confidence requires a direct framework binding, method symbol, or explicit
DI registration. Medium confidence is used for documented conventions and for a
single source implementation when no supported DI registration selects it.

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

Windows and WSL installations are separate. When Ripple runs in WSL, install
.NET 10 inside WSL even if `dotnet` is already available in PowerShell.
Prefer a WSL-local clone restored by that SDK. Windows-generated `obj` assets
can contain fallback package paths such as `C:\Program Files...` that Linux
MSBuild cannot resolve; Ripple surfaces this as `project-load-failed` rather
than silently falling back to text matching.
