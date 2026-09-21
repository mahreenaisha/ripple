#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".venv",
  ".vscode",
  "__pycache__",
  "bin",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "obj",
  "out",
  "target",
  "test",
  "tests",
  "__tests__",
  "vendor",
  "venv",
]);

const SOURCE_EXTENSIONS = new Set([
  ".cs",
  ".go",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".py",
  ".rb",
  ".rs",
  ".ts",
  ".tsx",
]);

function sourceFiles(directory) {
  const files = [];
  const queue = [directory];
  while (queue.length > 0) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = fs
        .readdirSync(current, { withFileTypes: true })
        .filter((entry) => !entry.isSymbolicLink())
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
        queue.push(absolutePath);
      } else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) &&
        !/\.generated\./i.test(entry.name) &&
        !/\.min\.(?:js|css)$/i.test(entry.name)
      ) {
        files.push(absolutePath);
      }
    }
  }
  return files;
}

function linesOfCode(directory) {
  return sourceFiles(directory).reduce((total, filePath) => {
    const text = fs.readFileSync(filePath, "utf8");
    return total + text.split(/\r?\n/).filter((line) => line.trim() !== "").length;
  }, 0);
}

function gitValue(rootPath, args) {
  const result = spawnSync("git", ["-C", rootPath, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function serviceLastModified(rootPath, servicePath) {
  return gitValue(rootPath, [
    "log",
    "-1",
    "--format=%cI",
    "--",
    servicePath,
  ]);
}

function repositoryUrl(rootPath, explicitUrl) {
  if (explicitUrl) {
    return explicitUrl;
  }
  return gitValue(rootPath, ["config", "--get", "remote.origin.url"]);
}

function queueEdgeTypes(evidence) {
  const types = [];
  if (/(?:publish|publisher|producer|sendmessage|emit)/i.test(evidence)) {
    types.push("publishes");
  }
  if (/(?:subscribe|subscriber|consumer|listen|listener|receive)/i.test(evidence)) {
    types.push("subscribes");
  }
  return types;
}

function graphEdgeTypes(dependency) {
  if (dependency.type === "database") {
    return ["queries"];
  }
  if (dependency.type === "message_queue") {
    return queueEdgeTypes(dependency.evidence);
  }
  if (dependency.type === "import") {
    return ["imports"];
  }
  if (["http_call", "external_api"].includes(dependency.type)) {
    return ["calls"];
  }
  return [];
}

function normalizedTarget(target, serviceIds) {
  if (serviceIds.has(target)) {
    return target;
  }
  const lower = target.toLowerCase();
  if (
    lower.includes("amazoncognito.com") ||
    lower.startsWith("cognito-idp.")
  ) {
    return "AWS Cognito";
  }
  if (lower.includes("scalars-access.com")) {
    return "Scalars Access";
  }
  return target;
}

function evidenceLocation(proof) {
  return proof.match(/^(.+:\d+): /)?.[1] || proof;
}

function isDatabaseOperation(proof) {
  return /(?:\.\s*(?:query|search|find|get|optionalget|index|insert|update|delete|remove|save|write|read|execute|bulk|scroll|count|currenttenantdatabase)\w*\s*(?:<[^>]*>)?\s*\(|\b(?:connectionstring|nodes|add\w*(?:opensearch|dynamo|database)|new\s+\w*(?:client|connection))\b)/i.test(
    proof,
  );
}

function aggregateEdges(dependencies, serviceIds) {
  const groups = new Map();

  for (const dependency of dependencies) {
    if (!serviceIds.has(dependency.from) || dependency.to.startsWith("internal:")) {
      continue;
    }
    const target = normalizedTarget(dependency.to, serviceIds);
    for (const type of graphEdgeTypes(dependency)) {
      const key = `${dependency.from}\0${target}\0${type}`;
      const current = groups.get(key) || {
        from: dependency.from,
        to: target,
        type,
        evidenceLocations: new Set(),
        operationLocations: new Set(),
      };
      current.evidenceLocations.add(evidenceLocation(dependency.evidence));
      if (type !== "queries" || isDatabaseOperation(dependency.evidence)) {
        current.operationLocations.add(evidenceLocation(dependency.evidence));
      }
      groups.set(key, current);
    }
  }

  return [...groups.values()]
    .map((edge) => {
      const operationCount = edge.operationLocations.size;
      const count =
        edge.type === "queries"
          ? Math.max(1, operationCount)
          : edge.evidenceLocations.size;
      const confidence =
        edge.type === "imports" ||
        ["publishes", "subscribes"].includes(edge.type) ||
        (edge.type === "queries" && operationCount > 0) ||
        (edge.type === "calls" && count > 1)
          ? "high"
          : "medium";
      return {
        from: edge.from,
        to: edge.to,
        type: edge.type,
        count,
        confidence,
      };
    })
    .filter(
      (edge) =>
        !(
          edge.type === "calls" &&
          serviceIds.has(edge.to) &&
          edge.count <= 1
        ),
    )
    .sort(
      (left, right) =>
        left.from.localeCompare(right.from) ||
        left.to.localeCompare(right.to) ||
        left.type.localeCompare(right.type),
    );
}

function buildDependencyGraph(
  repoPath,
  services,
  entryPoints,
  dependencies,
  options = {},
) {
  const rootPath = path.resolve(repoPath);
  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
    throw new Error(`Repository path is not a directory: ${repoPath}`);
  }
  if (!Array.isArray(services) || !Array.isArray(dependencies)) {
    throw new TypeError("services and dependencies must be arrays");
  }
  if (!entryPoints || typeof entryPoints !== "object" || Array.isArray(entryPoints)) {
    throw new TypeError("entryPoints must be an object");
  }

  const serviceIds = new Set(services.map((service) => service.name));
  const humanMetadata = options.metadata || {
    services: {},
    deployment_order: [],
    known_issues: [],
  };
  const edges = aggregateEdges(dependencies, serviceIds);
  const targetTypes = new Map();
  for (const dependency of dependencies) {
    const target = normalizedTarget(dependency.to, serviceIds);
    if (dependency.type === "database") {
      targetTypes.set(target, "database");
    } else if (!targetTypes.has(target)) {
      targetTypes.set(target, "external_api");
    }
  }

  const outgoing = new Map();
  const incoming = new Map();
  const incomingRuntime = new Map();
  for (const edge of edges) {
    if (!outgoing.has(edge.from)) {
      outgoing.set(edge.from, new Set());
    }
    if (!incoming.has(edge.to)) {
      incoming.set(edge.to, new Set());
    }
    outgoing.get(edge.from).add(edge.to);
    incoming.get(edge.to).add(edge.from);
    if (edge.type !== "imports") {
      if (!incomingRuntime.has(edge.to)) {
        incomingRuntime.set(edge.to, new Set());
      }
      incomingRuntime.get(edge.to).add(edge.from);
    }
  }

  const nodes = services.map((service) => {
    const serviceDirectory = path.resolve(rootPath, service.path);
    if (
      serviceDirectory !== rootPath &&
      !serviceDirectory.startsWith(`${rootPath}${path.sep}`)
    ) {
      throw new Error(`Service path escapes repository: ${service.path}`);
    }
    const entries = entryPoints[service.name]?.entries || [];
    const dependenciesOn = [...(outgoing.get(service.name) || [])].sort();
    const serviceMetadata = {
      status: "active",
      is_spof: false,
      gotchas: null,
      owner: null,
      ...(humanMetadata.services?.[service.name] || {}),
    };
    const derivedSpof = (incomingRuntime.get(service.name)?.size || 0) >= 2;
    return {
      id: service.name,
      type: "service",
      confidence: service.confidence || "high",
      spof_candidate: serviceMetadata.is_spof === true || derivedSpof,
      spof_source:
        serviceMetadata.is_spof === true
          ? "human"
          : derivedSpof
            ? "derived"
            : null,
      language: service.language,
      entry_points_count: entries.filter((entry) =>
        ["API", "CLI"].includes(entry.type),
      ).length,
      databases: dependenciesOn.filter(
        (target) => targetTypes.get(target) === "database",
      ),
      dependencies_on: dependenciesOn,
      dependents: [...(incoming.get(service.name) || [])].sort(),
      metadata: {
        last_modified: serviceLastModified(rootPath, service.path),
        lines_of_code: linesOfCode(serviceDirectory),
        ...serviceMetadata,
      },
    };
  });

  const nonServiceIds = new Set(
    edges.flatMap((edge) => [edge.from, edge.to]).filter((id) => !serviceIds.has(id)),
  );
  for (const id of [...nonServiceIds].sort()) {
    nodes.push({
      id,
      type: targetTypes.get(id) || "external_api",
      confidence: edges.some(
        (edge) => edge.to === id && edge.confidence === "high",
      )
        ? "high"
        : "medium",
      spof_candidate: (incomingRuntime.get(id)?.size || 0) >= 2,
      language: null,
      entry_points_count: 0,
      databases: [],
      dependencies_on: [...(outgoing.get(id) || [])].sort(),
      dependents: [...(incoming.get(id) || [])].sort(),
      metadata: {
        last_modified: null,
        lines_of_code: 0,
      },
    });
  }

  nodes.sort((left, right) => left.id.localeCompare(right.id));

  return {
    nodes,
    edges,
    metadata: {
      generated_at: new Date().toISOString(),
      repo_url: repositoryUrl(rootPath, options.repoUrl),
      total_services: services.length,
      total_nodes: nodes.length,
      total_edges: edges.length,
      edge_count_semantics: "unique source operation/evidence locations",
      deployment_order: humanMetadata.deployment_order || [],
      known_issues: humanMetadata.known_issues || [],
    },
  };
}

function runCli(argv) {
  if (!argv[2] || !argv[3] || !argv[4] || !argv[5]) {
    console.error(
      "Usage: node scanner/build-dependency-graph.js <repo-path> <services-json> <entry-points-json> <dependencies-json> [output-file] [repo-url]",
    );
    process.exitCode = 1;
    return;
  }

  try {
    const services = JSON.parse(fs.readFileSync(path.resolve(argv[3]), "utf8"));
    const entryPoints = JSON.parse(fs.readFileSync(path.resolve(argv[4]), "utf8"));
    const dependencies = JSON.parse(fs.readFileSync(path.resolve(argv[5]), "utf8"));
    const outputPath = path.resolve(argv[6] || "dependency-graph.json");
    const graph = buildDependencyGraph(
      argv[2],
      services,
      entryPoints,
      dependencies,
      { repoUrl: argv[7] },
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(graph, null, 2)}\n`);
    console.log(
      `Built graph with ${graph.nodes.length} node(s) and ${graph.edges.length} edge(s); wrote ${outputPath}`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runCli(process.argv);
}

module.exports = { buildDependencyGraph };
