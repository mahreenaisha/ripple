#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { identifyServices } = require("./identify-services");
const { extractEntryPoints } = require("./extract-entry-points");
const { extractDependencies } = require("./extract-dependencies");
const { extractRequestFlows } = require("./extract-request-flows");
const { buildDependencyGraph } = require("./build-dependency-graph");
const { generateDiagram } = require("./generate-diagram");
const {
  loadAndMergeMetadata,
  metadataToYaml,
} = require("./metadata-yaml");

function writeJson(outputDirectory, name, value) {
  fs.writeFileSync(
    path.join(outputDirectory, name),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function scanRepository(
  repoPath,
  outputPath = "architecture-snapshot",
  metadataPath,
) {
  const outputDirectory = path.resolve(outputPath);
  const resolvedMetadataPath = path.resolve(
    metadataPath || path.join(outputDirectory, "metadata.yaml"),
  );

  // Compute everything before writing so output files cannot affect the scan.
  const services = identifyServices(repoPath);
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

  fs.mkdirSync(outputDirectory, { recursive: true });
  writeJson(outputDirectory, "services.json", services);
  writeJson(outputDirectory, "entry-points.json", entryPoints);
  writeJson(outputDirectory, "dependencies.json", dependencies);
  writeJson(outputDirectory, "request-flows.json", requestFlows);
  writeJson(outputDirectory, "graph.json", graph);
  fs.mkdirSync(path.dirname(resolvedMetadataPath), { recursive: true });
  fs.writeFileSync(resolvedMetadataPath, metadataToYaml(metadata));
  generateDiagram(graph, outputDirectory, entryPoints);

  return {
    outputDirectory,
    metadataPath: resolvedMetadataPath,
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
}

function runCli(argv) {
  if (!argv[2]) {
    console.error(
      "Usage: node scanner/scan-repo.js <repo-path> [output-directory] [metadata-yaml]",
    );
    process.exitCode = 1;
    return;
  }

  try {
    const result = scanRepository(argv[2], argv[3], argv[4]);
    console.log(
      `Scan complete: ${result.services} service(s), ${result.nodes} node(s), ${result.edges} edge(s), ${result.flows} request flow(s)`,
    );
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

module.exports = { scanRepository };
