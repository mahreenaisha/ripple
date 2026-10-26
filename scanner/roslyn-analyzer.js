"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const PROJECT_DIRECTORY = path.join(__dirname, "Ripple.CSharpAnalyzer");
const PROJECT_FILE = path.join(PROJECT_DIRECTORY, "Ripple.CSharpAnalyzer.csproj");
const ANALYZER_DLL = path.join(
  PROJECT_DIRECTORY,
  "bin",
  "Release",
  "net8.0",
  "Ripple.CSharpAnalyzer.dll",
);

function dotnetExecutable() {
  const candidates = [
    process.env.RIPPLE_DOTNET,
    process.env.DOTNET_ROOT
      ? path.join(process.env.DOTNET_ROOT, process.platform === "win32" ? "dotnet.exe" : "dotnet")
      : null,
    "dotnet",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status === 0) {
      return candidate;
    }
  }
  throw new Error(
    "Ripple's C# scanner requires the .NET 8 SDK. Install it from https://dotnet.microsoft.com/download/dotnet/8.0 or set RIPPLE_DOTNET to the dotnet executable.",
  );
}

function analyzerSources() {
  return fs
    .readdirSync(PROJECT_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".cs") || entry.name.endsWith(".csproj")))
    .map((entry) => path.join(PROJECT_DIRECTORY, entry.name));
}

function needsBuild() {
  if (!fs.existsSync(ANALYZER_DLL)) {
    return true;
  }
  const builtAt = fs.statSync(ANALYZER_DLL).mtimeMs;
  return analyzerSources().some((source) => fs.statSync(source).mtimeMs > builtAt);
}

function ensureAnalyzer(dotnet) {
  if (!needsBuild()) {
    return;
  }
  try {
    execFileSync(
      dotnet,
      ["build", PROJECT_FILE, "-c", "Release", "--nologo", "--verbosity", "quiet"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message).trim();
    throw new Error(`Could not build Ripple's Roslyn analyzer: ${detail}`);
  }
}

function analyzeWithRoslyn(repoPath, services, options = {}) {
  const dotnet = dotnetExecutable();
  ensureAnalyzer(dotnet);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-roslyn-"));
  const configPath = path.join(temporary, "config.json");
  const config = {
    services: services.map((service) => ({
      name: service.name,
      path: service.path,
    })),
    maxDepth: Number.isInteger(options.maxDepth) ? options.maxDepth : 6,
    maxPathsPerTrigger: Number.isInteger(options.maxPathsPerTrigger)
      ? options.maxPathsPerTrigger
      : 8,
    maxFlows: Number.isInteger(options.maxFlows) ? options.maxFlows : 500,
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  try {
    const output = execFileSync(
      dotnet,
      [ANALYZER_DLL, path.resolve(repoPath), configPath],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: options.timeoutMs || 120000,
        maxBuffer: 128 * 1024 * 1024,
        env: {
          ...process.env,
          DOTNET_CLI_TELEMETRY_OPTOUT: "1",
          DOTNET_NOLOGO: "1",
        },
      },
    );
    return JSON.parse(output);
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message).trim();
    throw new Error(`Roslyn analysis failed: ${detail}`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = { analyzeWithRoslyn, dotnetExecutable };
