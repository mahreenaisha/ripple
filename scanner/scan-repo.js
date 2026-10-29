#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { identifyServices } = require("./identify-services");
const { extractRequestFlows } = require("./extract-request-flows");

const SNAPSHOTS_DIRECTORY = path.resolve(__dirname, "..", "snapshots");
const LEGACY_ARTIFACTS = [
  "architecture.html",
  "architecture.mmd",
  "architecture.svg",
  "dependencies.json",
  "entry-points.json",
  "graph.json",
  "metadata.yaml",
  "services.json",
  "team-diagrams.json",
];

function writeJson(outputDirectory, name, value) {
  fs.writeFileSync(
    path.join(outputDirectory, name),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function git(repoPath, args) {
  try {
    return execFileSync("git", ["-C", repoPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
    }).trim();
  } catch {
    return null;
  }
}

function stripCredentials(url) {
  return url ? url.replace(/\/\/[^@/]+@/, "//") : null;
}

/** Commit the scan reflects, so the UI can say "ground truth as of abc1234". */
function readGitSource(repoPath) {
  const commit = git(repoPath, ["rev-parse", "HEAD"]);
  if (!commit) {
    return { commit: null, branch: null, remote: null, committedAt: null };
  }
  return {
    commit,
    branch: git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    remote: stripCredentials(git(repoPath, ["config", "--get", "remote.origin.url"])),
    committedAt: git(repoPath, ["log", "-1", "--format=%cI"]),
  };
}

/** "wcc-deviceas" + services named Waters.DeviceAS.* gives "DeviceAS". */
function inferRepoName(repoPath, services) {
  const base = path.basename(path.resolve(repoPath)).replace(/^(wcc|waters)[-_]/i, "");
  const target = base.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const service of services) {
    for (const segment of String(service.name || service.id || "").split(/[./\\]/)) {
      if (segment.toLowerCase().replace(/[^a-z0-9]/g, "") === target) {
        return segment;
      }
    }
  }
  return base;
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
}

function scanRepository(repoPath, outputPath, options = {}) {
  const startedAt = Date.now();
  const services = identifyServices(repoPath);
  const name = options.name || inferRepoName(repoPath, services);
  const outputDirectory = path.resolve(
    outputPath || path.join(SNAPSHOTS_DIRECTORY, slugify(name)),
  );

  // Analyze before writing so output files cannot affect the scan.
  const requestFlows = extractRequestFlows(repoPath, services);
  const architectureGraph = requestFlows.architecture_graph;
  if (!architectureGraph || !Array.isArray(architectureGraph.nodes) ||
      !Array.isArray(architectureGraph.edges)) {
    throw new Error("Roslyn analyzer did not produce a valid architecture graph.");
  }
  const requestFlowArtifact = { ...requestFlows };
  delete requestFlowArtifact.architecture_graph;
  const source = {
    ...readGitSource(repoPath),
    localPath: path.resolve(repoPath),
    scannedAt: new Date().toISOString(),
  };

  const counts = {
    services: services.length,
    entryPoints: requestFlows.flows.filter((flow) => flow.trigger.kind === "api").length,
    flows: requestFlows.flows.length,
    graphNodes: architectureGraph.nodes.length,
    graphEdges: architectureGraph.edges.length,
  };

  fs.mkdirSync(outputDirectory, { recursive: true });
  for (const artifact of LEGACY_ARTIFACTS) {
    fs.rmSync(path.join(outputDirectory, artifact), { force: true });
  }
  writeJson(outputDirectory, "request-flows.json", {
    ...requestFlowArtifact,
    generator: { ...requestFlows.generator, source },
  });
  writeJson(outputDirectory, "architecture-graph.json", {
    ...architectureGraph,
    generator: { ...requestFlows.generator, source },
    analysis: requestFlows.analysis,
    limits: {
      max_nodes: 500,
      max_edges: 2000,
      max_evidence_per_edge: 50,
    },
  });

  writeJson(outputDirectory, "snapshot.json", {
    schema_version: 2,
    name,
    slug: slugify(name),
    source,
    analysis: requestFlows.analysis,
    artifacts: {
      request_flows: {
        file: "request-flows.json",
        schema_version: requestFlows.schema_version,
        status: "ready",
      },
      architecture_graph: {
        file: "architecture-graph.json",
        schema_version: architectureGraph.schema_version,
        status: "ready",
      },
    },
    counts,
    durationMs: Date.now() - startedAt,
  });

  return {
    outputDirectory,
    name,
    source,
    analysis: requestFlows.analysis,
    ...counts,
  };
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out" || arg === "--name") {
      options[arg.slice(2)] = argv[++index];
    } else {
      positional.push(arg);
    }
  }
  return {
    repoPath: positional[0],
    out: options.out || positional[1],
    name: options.name,
  };
}

function runCli(argv) {
  const args = parseArgs(argv);
  if (!args.repoPath) {
    console.error(
      "Usage: node scanner/scan-repo.js <repo-path> [--out snapshots/<name>] [--name DisplayName]",
    );
    process.exitCode = 1;
    return;
  }

  try {
    const result = scanRepository(args.repoPath, args.out, {
      name: args.name,
    });
    console.log(
      `Scan complete for ${result.name}: ${result.services} service(s), ${result.flows} request flow(s)`,
    );
    if (result.source.commit) {
      console.log(`Commit: ${result.source.commit.slice(0, 7)} on ${result.source.branch}`);
    }
    console.log(`Output: ${result.outputDirectory}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runCli(process.argv);
}

module.exports = { scanRepository, inferRepoName, parseArgs, slugify };
