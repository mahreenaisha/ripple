#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { analyzeWithRoslyn } = require("./roslyn-analyzer");
const { identifyServices } = require("./identify-services");
const { buildStories } = require("./flow-story");

const SCHEMA_VERSION = "1.0.0";
const IGNORED_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", ".idea", ".vscode", "bin", "obj", "out", "build",
  "dist", "generated", "vendor", "node_modules", "test", "tests", "__tests__",
]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function collectStoryInputs(rootPath) {
  const sources = [];
  const configFiles = [];
  const queue = [rootPath];
  while (queue.length) {
    const directory = queue.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
        .filter((entry) => !entry.isSymbolicLink())
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
        queue.push(absolute);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".cs")) {
        sources.push({
          absolute,
          file: toPosix(path.relative(rootPath, absolute)),
          extension: ".cs",
          text: fs.readFileSync(absolute, "utf8"),
        });
      } else if (entry.isFile() && entry.name.toLowerCase() === "appsettings.json") {
        configFiles.push({
          absolute,
          file: toPosix(path.relative(rootPath, absolute)),
        });
      }
    }
  }
  return {
    sources: sources.sort((left, right) => left.file.localeCompare(right.file)),
    configFiles: configFiles.sort((left, right) => left.file.localeCompare(right.file)),
  };
}

function braceBody(text, openOffset) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openOffset; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) {
      return text.slice(openOffset + 1, index);
    }
  }
  return text.slice(openOffset + 1);
}

// Story enrichment uses method bodies only to locate docs, publishers, metrics,
// and settings. Structural route and call resolution comes exclusively from Roslyn.
function storyFunctions(source) {
  const classRanges = [];
  for (const match of source.text.matchAll(/\bclass\s+([A-Za-z_]\w*)[^{]*\{/g)) {
    const open = match.index + match[0].lastIndexOf("{");
    classRanges.push({
      name: match[1],
      start: match.index,
      end: open + braceBody(source.text, open).length + 1,
    });
  }
  const functions = [];
  const pattern = /\b(?:public|private|protected|internal|static|virtual|override|sealed|async|\s)+(?:[\w.<>,?[\]]+\s+)+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:=>[^{;\n]*;|\{)/g;
  for (const match of source.text.matchAll(pattern)) {
    const className = classRanges
      .find((range) => match.index >= range.start && match.index <= range.end)?.name || "";
    const declaration = match[0];
    const body = declaration.includes("{")
      ? braceBody(source.text, match.index + declaration.lastIndexOf("{"))
      : declaration;
    functions.push({
      name: match[1],
      className,
      symbol: className ? `${className}.${match[1]}` : match[1],
      body,
      file: source.file,
      line: source.text.slice(0, match.index).split(/\r?\n/).length,
      source,
    });
  }
  return functions;
}

function glossary() {
  return {
    flow: "One evidence-backed path from an entry point toward a meaningful boundary.",
    trigger: "The ASP.NET route or queue message that starts work.",
    API: "An application programming interface exposed for another program to call.",
    OData: "A standard for querying and changing data through HTTP APIs.",
    handler: "The first function or method directly bound to a trigger.",
    call: "A direct source-code call whose target Roslyn resolved to a C# method symbol.",
    database: "A compiler-resolved call into persistent storage; traversal stops here.",
    external: "A compiler-resolved call that appears to leave the process; traversal stops here.",
    queue: "A compiler-resolved publish or enqueue call; downstream processing is a separate flow.",
    confidence: "High means a direct framework, compiler, or DI binding. Medium means a documented convention or a unique implementation without an explicit DI registration.",
    evidence: "The concrete syntax and symbol relationship supporting a step. It is not runtime proof.",
    warning: "A place where the compilation, dispatch target, dynamic behavior, or output safety limit prevented a verified path.",
    "inference limit": "A known call whose runtime target could not be selected safely, or a configured traversal limit.",
    tenant: "A customer or organizational boundary whose data and configuration are isolated.",
    adapter: "Code that translates between an application-facing interface and an external technology.",
    provider: "A component that supplies data or operations behind an interface.",
    port: "An application-owned interface through which core logic communicates with adapters.",
    "entity provider": "A provider that loads or stores domain entities, often through a search or database system.",
    OpenSearch: "A search and document-storage engine; named only when matching source or symbol evidence exists.",
    "IoT thing": "A cloud representation of a physical or logical Internet of Things device.",
    Greengrass: "AWS edge software used to deploy and run workloads near IoT devices.",
    SQS: "Amazon Simple Queue Service, used for asynchronous message delivery.",
    EventBridge: "An AWS event bus used to route events between producers and consumers.",
    MQTT: "A lightweight publish/subscribe protocol commonly used by IoT devices.",
    SPOF: "Single point of failure: one component whose loss can stop a larger workflow.",
  };
}

function extractRequestFlows(repoPath, services = [], options = {}, legacyOptions) {
  const rootPath = path.resolve(repoPath);
  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
    throw new Error(`Repository path is not a directory: ${repoPath}`);
  }
  const selectedServices = services.length ? services : identifyServices(rootPath);
  const analyzerOptions = legacyOptions || (
    options && (
      "mode" in options ||
      "maxDepth" in options ||
      "maxPathsPerTrigger" in options ||
      "maxFlows" in options
    )
      ? options
      : {}
  );
  const result = analyzeWithRoslyn(rootPath, selectedServices, analyzerOptions);
  const storyInputs = collectStoryInputs(rootPath);
  buildStories(result.flows, {
    ...storyInputs,
    functions: storyInputs.sources.flatMap(storyFunctions),
  });
  return {
    ...result,
    schema_version: SCHEMA_VERSION,
    glossary: glossary(),
  };
}

function runCli(argv) {
  if (!argv[2]) {
    console.error("Usage: node scanner/extract-request-flows.js <repo-path> [output-file]");
    process.exitCode = 1;
    return;
  }
  try {
    const outputPath = path.resolve(argv[3] || "request-flows.json");
    const result = extractRequestFlows(argv[2]);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Identified ${result.flows.length} request flow(s); wrote ${outputPath}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) runCli(process.argv);

module.exports = { SCHEMA_VERSION, extractRequestFlows };
