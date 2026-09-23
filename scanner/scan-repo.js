#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { identifyServices } = require("./identify-services");
const { extractEntryPoints } = require("./extract-entry-points");
const { extractDependencies } = require("./extract-dependencies");
const { extractRequestFlows } = require("./extract-request-flows");
const { buildDependencyGraph } = require("./build-dependency-graph");
const { generateDiagram } = require("./generate-diagram");
const { collectTeamDiagrams } = require("./team-diagrams");
const {
  loadAndMergeMetadata,
  metadataToYaml,
} = require("./metadata-yaml");

const SNAPSHOTS_DIRECTORY = path.resolve(__dirname, "..", "snapshots");

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

function scanRepository(repoPath, outputPath, metadataPath, options = {}) {
  const startedAt = Date.now();
  const services = identifyServices(repoPath);
  const name = options.name || inferRepoName(repoPath, services);
  const outputDirectory = path.resolve(
    outputPath || path.join(SNAPSHOTS_DIRECTORY, slugify(name)),
  );
  const resolvedMetadataPath = path.resolve(
    metadataPath || path.join(outputDirectory, "metadata.yaml"),
  );

  // Compute everything before writing so output files cannot affect the scan.
  const metadata = loadAndMergeMetadata(resolvedMetadataPath, services);
  const entryPoints = extractEntryPoints(repoPath, services);
  const dependencies = extractDependencies(repoPath, services);
  const requestFlows = extractRequestFlows(repoPath, services, entryPoints);
  const graph = buildDependencyGraph(
    repoPath,
    services,
    entryPoints,
    dependencies,
    { metadata },
  );
  const teamDiagrams = collectTeamDiagrams(repoPath);
  const source = {
    ...readGitSource(repoPath),
    localPath: path.resolve(repoPath),
    scannedAt: new Date().toISOString(),
  };

  const counts = {
    services: services.length,
    entryPoints: Object.values(entryPoints).reduce(
      (total, service) => total + service.entries.length,
      0,
    ),
    dependencies: dependencies.length,
    flows: requestFlows.flows.length,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
  };

  fs.mkdirSync(outputDirectory, { recursive: true });
  writeJson(outputDirectory, "services.json", services);
  writeJson(outputDirectory, "entry-points.json", entryPoints);
  writeJson(outputDirectory, "dependencies.json", dependencies);
  writeJson(outputDirectory, "request-flows.json", {
    ...requestFlows,
    generator: { ...requestFlows.generator, source },
  });
  writeJson(outputDirectory, "graph.json", graph);
  writeJson(outputDirectory, "team-diagrams.json", teamDiagrams);
  fs.mkdirSync(path.dirname(resolvedMetadataPath), { recursive: true });
  fs.writeFileSync(resolvedMetadataPath, metadataToYaml(metadata));
  generateDiagram(graph, outputDirectory, entryPoints);
  writeJson(outputDirectory, "snapshot.json", {
    schema_version: 1,
    name,
    slug: path.basename(outputDirectory),
    source,
    counts,
    durationMs: Date.now() - startedAt,
  });

  return {
    outputDirectory,
    metadataPath: resolvedMetadataPath,
    name,
    source,
    ...counts,
  };
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out" || arg === "--name" || arg === "--metadata") {
      options[arg.slice(2)] = argv[++index];
    } else {
      positional.push(arg);
    }
  }
  return {
    repoPath: positional[0],
    out: options.out || positional[1],
    metadata: options.metadata || positional[2],
    name: options.name,
  };
}

function runCli(argv) {
  const args = parseArgs(argv);
  if (!args.repoPath) {
    console.error(
      "Usage: node scanner/scan-repo.js <repo-path> [--out snapshots/<name>] [--name DisplayName] [--metadata file.yaml]",
    );
    process.exitCode = 1;
    return;
  }

  try {
    const result = scanRepository(args.repoPath, args.out, args.metadata, { name: args.name });
    console.log(
      `Scan complete for ${result.name}: ${result.services} service(s), ${result.nodes} node(s), ${result.edges} edge(s), ${result.flows} request flow(s)`,
    );
    if (result.source.commit) {
      console.log(`Commit: ${result.source.commit.slice(0, 7)} on ${result.source.branch}`);
    }
    console.log(`Output: ${result.outputDirectory}`);
    console.log(`Metadata: ${result.metadataPath}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runCli(process.argv);
}

module.exports = { scanRepository, inferRepoName, parseArgs, slugify };
