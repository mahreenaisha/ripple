#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".angular",
  ".cache",
  ".idea",
  ".next",
  ".nuxt",
  ".pytest_cache",
  ".tox",
  ".venv",
  ".vscode",
  "__pycache__",
  "bin",
  "build",
  "coverage",
  "dist",
  "fixtures",
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

const SERVICE_CONTAINERS = new Set(["apps", "packages", "services"]);
const PYTHON_MANIFESTS = ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"];
const JAVA_MANIFESTS = ["pom.xml", "build.gradle", "build.gradle.kts"];

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function existsFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
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

  while (queue.length > 0) {
    const current = queue.shift();
    directories.push(current);

    for (const entry of listDirectory(current)) {
      if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) {
        queue.push(path.join(current, entry.name));
      }
    }
  }

  return directories;
}

function solutionProjectDirectories(directories) {
  const projects = new Set();
  const projectPattern = /"([^"]+\.csproj)"/gi;

  for (const directory of directories) {
    for (const entry of listDirectory(directory)) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".sln")) {
        continue;
      }

      const solution = readText(path.join(directory, entry.name));
      for (const match of solution.matchAll(projectPattern)) {
        const projectPath = match[1].replaceAll("\\", path.sep).replaceAll("/", path.sep);
        projects.add(path.resolve(directory, path.dirname(projectPath)));
      }
    }
  }

  return projects;
}

function isCandidateDirectory(directory, rootPath, solutionProjects) {
  if (directory === rootPath || solutionProjects.has(directory)) {
    return true;
  }

  const relative = path.relative(rootPath, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }

  const parts = relative.split(path.sep);
  return parts.length === 1 || parts.some((part) => SERVICE_CONTAINERS.has(part));
}

function firstExisting(directory, relativePaths) {
  for (const relativePath of relativePaths) {
    if (existsFile(path.join(directory, relativePath))) {
      return relativePath;
    }
  }
  return null;
}

function filesRecursively(directory, predicate, maxDepth = 5, depth = 0) {
  if (depth > maxDepth) {
    return [];
  }

  const matches = [];
  for (const entry of listDirectory(directory)) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isFile() && predicate(entry.name, absolutePath)) {
      matches.push(absolutePath);
    } else if (
      entry.isDirectory() &&
      !IGNORED_DIRECTORIES.has(entry.name) &&
      depth < maxDepth
    ) {
      matches.push(...filesRecursively(absolutePath, predicate, maxDepth, depth + 1));
    }
  }
  return matches;
}

function commandEntry(script) {
  if (typeof script !== "string") {
    return null;
  }

  const match = script.match(
    /(?:^|&&\s*|;\s*)(?:node|tsx|ts-node|nodemon)\s+([^\s"';&|]+\.(?:[cm]?[jt]s|tsx?))/,
  );
  return match ? match[1].replace(/^\.\//, "") : null;
}

function nodeService(directory) {
  const manifestPath = path.join(directory, "package.json");
  if (!existsFile(manifestPath)) {
    return null;
  }

  const manifest = readJson(manifestPath);
  if (!manifest) {
    return null;
  }

  const declared = [];
  const binEntries = [];
  if (typeof manifest.bin === "string") {
    declared.push(manifest.bin);
    binEntries.push(manifest.bin);
  } else if (manifest.bin && typeof manifest.bin === "object") {
    binEntries.push(
      ...Object.values(manifest.bin).filter((value) => typeof value === "string"),
    );
    declared.push(...binEntries);
  }
  for (const field of ["main", "module"]) {
    if (typeof manifest[field] === "string") {
      declared.push(manifest[field]);
    }
  }
  for (const scriptName of ["start", "serve", "dev"]) {
    const entry = commandEntry(manifest.scripts?.[scriptName]);
    if (entry) {
      declared.push(entry);
    }
  }

  const entry = firstExisting(directory, [
    ...declared,
    "src/main.ts",
    "src/main.js",
    "main.ts",
    "main.js",
    "src/index.ts",
    "src/index.js",
    "index.ts",
    "index.js",
    "src/server.ts",
    "src/server.js",
    "server.ts",
    "server.js",
    "src/app.ts",
    "src/app.js",
  ]);
  if (!entry) {
    return null;
  }

  const packageName =
    typeof manifest.name === "string" ? manifest.name.replace(/^@[^/]+\//, "") : null;
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
  };
  const isWebApp = Object.keys(dependencies).some((name) =>
    ["@angular/core", "react", "vue", "svelte"].includes(name),
  );
  const isApi = Object.keys(dependencies).some((name) =>
    ["@nestjs/core", "express", "fastify", "hapi", "koa"].includes(name),
  );
  const kind = binEntries.length > 0 ? "cli" : isWebApp ? "web-app" : isApi ? "api-service" : "application";

  return {
    language: "Node.js",
    entry,
    declaredName: packageName,
    kind,
    confidence: kind === "application" ? "medium" : "high",
    evidence: [
      "manifest: package.json",
      `entrypoint: ${toPosix(entry)}`,
      ...(binEntries.length > 0
        ? ["package metadata: bin"]
        : isWebApp
          ? ["framework: browser application"]
          : isApi
            ? ["framework: Node.js server"]
            : []),
    ],
  };
}

function pythonService(directory) {
  if (!PYTHON_MANIFESTS.some((manifest) => existsFile(path.join(directory, manifest)))) {
    return null;
  }

  const entry = firstExisting(directory, [
    "app.py",
    "main.py",
    "manage.py",
    "__main__.py",
    "src/app.py",
    "src/main.py",
    "wsgi.py",
    "asgi.py",
    "cli.py",
  ]);
  if (!entry) {
    return null;
  }

  const manifestText = PYTHON_MANIFESTS.map((manifest) =>
    readText(path.join(directory, manifest)),
  )
    .join("\n")
    .toLowerCase();
  const isApi = /\b(fastapi|flask|django)\b/.test(manifestText);
  const isCli = ["cli.py", "__main__.py"].includes(toPosix(entry));
  const kind = isApi ? "api-service" : isCli ? "cli" : "application";
  return {
    language: "Python",
    entry,
    kind,
    confidence: kind === "application" ? "medium" : "high",
    evidence: [
      `manifest: ${PYTHON_MANIFESTS.find((manifest) => existsFile(path.join(directory, manifest)))}`,
      `entrypoint: ${toPosix(entry)}`,
      ...(isApi ? ["framework: Python web framework"] : []),
    ],
  };
}

function goService(directory) {
  if (!existsFile(path.join(directory, "go.mod"))) {
    return null;
  }

  let entry = firstExisting(directory, ["main.go"]);
  if (!entry) {
    const commandEntries = filesRecursively(
      path.join(directory, "cmd"),
      (name) => name === "main.go",
      3,
    ).sort();
    if (commandEntries.length > 0) {
      entry = path.relative(directory, commandEntries[0]);
    }
  }
  return entry
    ? {
        language: "Go",
        entry,
        kind: "application",
        confidence: "medium",
        evidence: ["manifest: go.mod", `entrypoint: ${toPosix(entry)}`],
      }
    : null;
}

function javaService(directory) {
  if (!JAVA_MANIFESTS.some((manifest) => existsFile(path.join(directory, manifest)))) {
    return null;
  }

  const sourceRoot = path.join(directory, "src", "main", "java");
  const entries = filesRecursively(
    sourceRoot,
    (name, absolutePath) =>
      /(?:Application|Main)\.java$/.test(name) &&
      /\bstatic\s+void\s+main\s*\(/.test(readText(absolutePath)),
    10,
  ).sort((left, right) => {
    const leftApplication = left.endsWith("Application.java") ? 0 : 1;
    const rightApplication = right.endsWith("Application.java") ? 0 : 1;
    return leftApplication - rightApplication || left.localeCompare(right);
  });

  if (entries.length === 0) {
    return null;
  }

  const entry = path.relative(directory, entries[0]);
  const isApi = /\bSpringApplication\.run\s*\(/.test(readText(entries[0]));
  return {
    language: "Java",
    entry,
    kind: isApi ? "api-service" : "application",
    confidence: isApi ? "high" : "medium",
    evidence: [
      `manifest: ${JAVA_MANIFESTS.find((manifest) => existsFile(path.join(directory, manifest)))}`,
      `entrypoint: ${toPosix(entry)}`,
      ...(isApi ? ["framework: Spring application"] : []),
    ],
  };
}

function rubyService(directory) {
  if (!existsFile(path.join(directory, "Gemfile"))) {
    return null;
  }

  let entry = firstExisting(directory, ["config.ru", "app.rb", "main.rb"]);
  if (!entry) {
    const binEntries = listDirectory(path.join(directory, "bin")).filter((item) =>
      item.isFile(),
    );
    if (binEntries.length > 0) {
      entry = path.join("bin", binEntries[0].name);
    }
  }
  if (!entry) {
    return null;
  }
  const kind = entry === "config.ru" ? "api-service" : entry.startsWith(`bin${path.sep}`) ? "cli" : "application";
  return {
    language: "Ruby",
    entry,
    kind,
    confidence: kind === "application" ? "medium" : "high",
    evidence: [
      "manifest: Gemfile",
      `entrypoint: ${toPosix(entry)}`,
      ...(entry === "config.ru" ? ["framework: Rack"] : []),
    ],
  };
}

function csharpService(directory) {
  const projectFiles = listDirectory(directory)
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csproj"))
    .map((entry) => entry.name);
  if (projectFiles.length === 0) {
    return null;
  }

  for (const projectFile of projectFiles) {
    const project = readText(path.join(directory, projectFile));
    const isLibrary = /<OutputType>\s*Library\s*<\/OutputType>/i.test(project);
    const isExecutable =
      /<Project\s+Sdk=["'][^"']*Microsoft\.NET\.Sdk\.Web/i.test(project) ||
      /<OutputType>\s*(?:Exe|WinExe)\s*<\/OutputType>/i.test(project);
    if (isLibrary || !isExecutable) {
      continue;
    }

    const entries = filesRecursively(
      directory,
      (name) => name.toLowerCase() === "program.cs",
      5,
    ).sort();
    if (entries.length > 0) {
      const usesCommandLine = /System\.CommandLine/.test(project);
      const isWeb = /<Project\s+Sdk=["'][^"']*Microsoft\.NET\.Sdk\.Web/i.test(project);
      return {
        language: "C#",
        entry: path.relative(directory, entries[0]),
        declaredName: path.basename(projectFile, path.extname(projectFile)),
        kind: isWeb ? "api-service" : usesCommandLine ? "cli" : "application",
        confidence: isWeb || usesCommandLine ? "high" : "medium",
        evidence: [
          `manifest: ${projectFile}`,
          `entrypoint: ${toPosix(path.relative(directory, entries[0]))}`,
          ...(isWeb
            ? ["project SDK: Microsoft.NET.Sdk.Web"]
            : ["project output: Exe"]),
          ...(usesCommandLine ? ["framework: System.CommandLine"] : []),
        ],
      };
    }
  }
  return null;
}

const DETECTORS = [
  nodeService,
  pythonService,
  goService,
  javaService,
  rubyService,
  csharpService,
];

function serviceName(directory, rootPath, detected) {
  if (detected.declaredName) {
    return detected.declaredName;
  }
  if (directory === rootPath) {
    return path.basename(rootPath);
  }
  return path.basename(directory);
}

function deploymentFiles(directories) {
  const supportedNames = new Set(["Dockerfile"]);
  const supportedExtensions = new Set([".tf", ".yaml", ".yml"]);
  const files = [];

  for (const directory of directories) {
    for (const entry of listDirectory(directory)) {
      if (
        entry.isFile() &&
        (supportedNames.has(entry.name) ||
          supportedExtensions.has(path.extname(entry.name).toLowerCase()))
      ) {
        const filePath = path.join(directory, entry.name);
        files.push({ path: filePath, text: readText(filePath) });
      }
    }
  }
  return files;
}

function refineClassification(directory, detected, deploymentArtifacts) {
  if (detected.language !== "C#") {
    return detected;
  }

  const readme = ["README.md", "README.MD"]
    .map((name) => readText(path.join(directory, name)))
    .join("\n");
  if (/Kubernetes job/i.test(readme)) {
    return {
      ...detected,
      kind: "job",
      confidence: "high",
      evidence: [...detected.evidence, "documentation: Kubernetes job"],
    };
  }

  const assemblyName = `${detected.declaredName}.dll`;
  for (const artifact of deploymentArtifacts) {
    const lines = artifact.text.split(/\r?\n/);
    const assemblyLine = lines.findIndex((line) => line.includes(assemblyName));
    if (assemblyLine < 0) {
      continue;
    }
    const nearbyText = lines
      .slice(Math.max(0, assemblyLine - 20), assemblyLine + 5)
      .join("\n");
    if (/init_containers/i.test(nearbyText)) {
      return {
        ...detected,
        kind: "init-container",
        confidence: "high",
        evidence: [...detected.evidence, "deployment: Terraform init container"],
      };
    }
  }

  return detected;
}

function identifyServices(repoPath) {
  if (typeof repoPath !== "string" || repoPath.trim() === "") {
    throw new TypeError("repoPath must be a non-empty string");
  }

  const rootPath = path.resolve(repoPath);
  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
    throw new Error(`Repository path is not a directory: ${repoPath}`);
  }

  const directories = walkDirectories(rootPath);
  const solutionProjects = solutionProjectDirectories(directories);
  const deploymentArtifacts = deploymentFiles(directories);
  const services = [];
  const detectedDirectories = [];

  for (const directory of directories) {
    if (!isCandidateDirectory(directory, rootPath, solutionProjects)) {
      continue;
    }

    const nestedInService = detectedDirectories.some((serviceDirectory) => {
      if (serviceDirectory === rootPath) {
        return false;
      }
      const relative = path.relative(serviceDirectory, directory);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return false;
      }
      return !relative.split(path.sep).some((part) => SERVICE_CONTAINERS.has(part));
    });
    if (nestedInService) {
      continue;
    }

    const sourceDetection = DETECTORS.map((detect) => detect(directory)).find(Boolean);
    if (!sourceDetection) {
      continue;
    }
    const detected = refineClassification(
      directory,
      sourceDetection,
      deploymentArtifacts,
    );

    detectedDirectories.push(directory);
    const relativeDirectory = path.relative(rootPath, directory) || ".";
    services.push({
      name: serviceName(directory, rootPath, detected),
      path: toPosix(relativeDirectory),
      language: detected.language,
      entry_file: toPosix(path.join(relativeDirectory, detected.entry)),
      kind: detected.kind,
      confidence: detected.confidence,
      evidence: detected.evidence,
    });
  }

  return services.sort((left, right) => left.path.localeCompare(right.path));
}

function runCli(argv) {
  const repoPath = argv[2];
  if (!repoPath) {
    console.error("Usage: node scanner/identify-services.js <repo-path> [output-file]");
    process.exitCode = 1;
    return;
  }

  const outputPath = path.resolve(argv[3] || "services.json");
  try {
    const services = identifyServices(repoPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(services, null, 2)}\n`);
    console.log(`Identified ${services.length} service(s); wrote ${outputPath}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runCli(process.argv);
}

module.exports = { identifyServices };
