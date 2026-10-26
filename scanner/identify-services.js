#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".vscode",
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
]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function listDirectory(directory) {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => !entry.isSymbolicLink())
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

function walkDirectories(rootPath) {
  const directories = [];
  const queue = [rootPath];
  while (queue.length) {
    const directory = queue.shift();
    directories.push(directory);
    for (const entry of listDirectory(directory)) {
      if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
        queue.push(path.join(directory, entry.name));
      }
    }
  }
  return directories;
}

function findProgramFile(directory, maxDepth = 5, depth = 0) {
  if (depth > maxDepth) {
    return null;
  }
  for (const entry of listDirectory(directory)) {
    const absolute = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === "program.cs") {
      return absolute;
    }
    if (
      entry.isDirectory() &&
      !IGNORED_DIRECTORIES.has(entry.name.toLowerCase()) &&
      depth < maxDepth
    ) {
      const nested = findProgramFile(absolute, maxDepth, depth + 1);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

function classifyProject(projectFile) {
  const project = readText(projectFile);
  if (/<OutputType>\s*Library\s*<\/OutputType>/i.test(project)) {
    return null;
  }
  const isWeb = /<Project\s+Sdk=["'][^"']*Microsoft\.NET\.Sdk\.Web/i.test(project);
  const isExecutable =
    isWeb || /<OutputType>\s*(?:Exe|WinExe)\s*<\/OutputType>/i.test(project);
  if (!isExecutable) {
    return null;
  }
  return {
    kind: isWeb ? "api-service" : "application",
    evidence: isWeb
      ? ["project SDK: Microsoft.NET.Sdk.Web"]
      : ["project output: Exe"],
  };
}

function identifyServices(repoPath) {
  if (typeof repoPath !== "string" || !repoPath.trim()) {
    throw new TypeError("repoPath must be a non-empty string");
  }
  const rootPath = path.resolve(repoPath);
  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
    throw new Error(`Repository path is not a directory: ${repoPath}`);
  }

  const services = [];
  for (const directory of walkDirectories(rootPath)) {
    for (const entry of listDirectory(directory)) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".csproj")) {
        continue;
      }
      const projectFile = path.join(directory, entry.name);
      const classification = classifyProject(projectFile);
      const programFile = classification && findProgramFile(directory);
      if (!classification || !programFile) {
        continue;
      }
      const relativeDirectory = path.relative(rootPath, directory) || ".";
      services.push({
        name: path.basename(entry.name, path.extname(entry.name)),
        path: toPosix(relativeDirectory),
        language: "C#",
        entry_file: toPosix(path.relative(rootPath, programFile)),
        kind: classification.kind,
        confidence: "high",
        evidence: [
          `manifest: ${entry.name}`,
          `entrypoint: ${toPosix(path.relative(directory, programFile))}`,
          ...classification.evidence,
        ],
      });
    }
  }
  return services.sort((left, right) => left.path.localeCompare(right.path));
}

function runCli(argv) {
  if (!argv[2]) {
    console.error("Usage: node scanner/identify-services.js <repo-path> [output-file]");
    process.exitCode = 1;
    return;
  }
  try {
    const services = identifyServices(argv[2]);
    const outputPath = path.resolve(argv[3] || "services.json");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(services, null, 2)}\n`);
    console.log(`Identified ${services.length} C# service(s); wrote ${outputPath}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runCli(process.argv);
}

module.exports = { identifyServices };
