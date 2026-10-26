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

function sourceFiles(directory) {
  const files = [];
  const queue = [directory];
  while (queue.length) {
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
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
        queue.push(absolute);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".cs")) {
        files.push(absolute);
      }
    }
  }
  return files.sort();
}

function addEntry(entries, endpoint, file, line) {
  if (endpoint) {
    entries.push({ type: "API", endpoint: endpoint.trim(), file, line });
  }
}

function joinRoute(prefix, route) {
  const parts = [prefix, route]
    .filter(Boolean)
    .map((part) => String(part).replace(/^\/+|\/+$/g, ""));
  return `/${parts.join("/")}`.replace(/\/+/g, "/");
}

function odataPrefix(files) {
  for (const filePath of files) {
    const match = readText(filePath).match(
      /Add\w*OData\([\s\S]{0,300}?["']([^"']+)["']/,
    );
    if (match) {
      return match[1];
    }
  }
  return null;
}

function csharpMethod(line) {
  const match = line.match(
    /\b(public|internal|protected|private)\s+(?:async\s+)?(?:static\s+)?(?:[\w?.\[\],<>]+\s+)+(\w+)\s*\(/,
  );
  return match ? { access: match[1], name: match[2] } : null;
}

function odataEndpoint(prefix, controllerName, methodName, verb, hasKey = false) {
  const entitySet = controllerName.replace(/Controller$/, "");
  const base = joinRoute(prefix, entitySet);
  if (methodName === "Get") {
    return `${verb} ${base}`;
  }
  const action = methodName.match(
    new RegExp(`^(.+?)On(?:${entitySet.replace(/s$/, "")})?$`),
  );
  if (action) {
    return `${verb} ${base}({key})/${action[1]}`;
  }
  if (methodName === `Get${entitySet.replace(/s$/, "")}`) {
    return `${verb} ${base}({key})`;
  }
  if (methodName.startsWith("Post")) {
    return `${verb} ${base}`;
  }
  if (/^(Put|Patch|Delete)/.test(methodName)) {
    return `${verb} ${base}({key})`;
  }
  const navigation = methodName.match(/^Get(.+)From/);
  if (navigation) {
    return `${verb} ${base}({key})/${navigation[1]}`;
  }
  return `${verb} ${hasKey ? `${base}({key})` : base}/${methodName}`;
}

function extractControllers(text, file, entries, prefix) {
  const lines = text.split(/\r?\n/);
  let className = "";
  let classRoute = "";
  let isODataController = false;
  let pendingAttributes = [];

  lines.forEach((line, index) => {
    for (const match of line.matchAll(
      /\[(Route|HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete|AcceptVerbs)(?:\(\s*["']([^"']*)["'][^)]*\))?\]/g,
    )) {
      pendingAttributes.push({
        name: match[1],
        route: match[2] || "",
        line: index + 1,
      });
    }

    const classMatch = line.match(/\bclass\s+(\w+)[^{]*(?::\s*([^{]+))?/);
    if (classMatch) {
      className = classMatch[1];
      isODataController =
        /ODataBaseController|ODataController/.test(classMatch[2] || "") ||
        new RegExp(
          `class\\s+${className}[\\s\\S]{0,300}:\\s*(?:[\\w.]+\\.)?OData(?:Base)?Controller\\b`,
        ).test(text);
      const route = pendingAttributes.find((attribute) => attribute.name === "Route");
      classRoute = (route?.route || "").replace(
        /\[controller\]/gi,
        className.replace(/Controller$/, ""),
      );
      pendingAttributes = [];
      return;
    }

    const method = csharpMethod(line);
    if (!method) {
      return;
    }
    if (method.access !== "public") {
      pendingAttributes = [];
      return;
    }

    const httpAttributes = pendingAttributes.filter((attribute) =>
      attribute.name.startsWith("Http"),
    );
    const signature = lines.slice(index, index + 5).join(" ");
    const hasKey = /\b(?:string|Guid)\s+key\b/.test(signature);
    for (const attribute of httpAttributes) {
      const verb = attribute.name.slice(4).toUpperCase();
      if (classRoute || attribute.route) {
        addEntry(
          entries,
          `${verb} ${joinRoute(classRoute, attribute.route)}`,
          file,
          attribute.line,
        );
      } else if (isODataController && prefix) {
        addEntry(
          entries,
          odataEndpoint(prefix, className, method.name, verb, hasKey),
          file,
          attribute.line,
        );
      }
    }
    if (!httpAttributes.length && isODataController && prefix) {
      const verb = method.name.match(/^(Get|Post|Put|Patch|Delete)/)?.[1]?.toUpperCase();
      if (verb) {
        addEntry(
          entries,
          odataEndpoint(prefix, className, method.name, verb, hasKey),
          file,
          index + 1,
        );
      }
    }
    pendingAttributes = [];
  });
}

function extractMinimalApis(text, file, entries) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const match of line.matchAll(
      /\.Map(Get|Post|Put|Patch|Delete)\(\s*["']([^"']+)["']/g,
    )) {
      addEntry(entries, `${match[1].toUpperCase()} ${match[2]}`, file, index + 1);
    }
    const health = line.match(/\.MapHealthChecks\(\s*["']([^"']+)["']/);
    if (health) {
      addEntry(entries, `GET ${health[1]}`, file, index + 1);
    }
  });
}

function uniqueSorted(entries) {
  const seen = new Set();
  return entries
    .filter((entry) => {
      const key = `${entry.endpoint}\0${entry.file}\0${entry.line}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.line - right.line ||
        left.endpoint.localeCompare(right.endpoint),
    );
}

function extractEntryPoints(repoPath, services) {
  const rootPath = path.resolve(repoPath);
  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
    throw new Error(`Repository path is not a directory: ${repoPath}`);
  }
  if (!Array.isArray(services)) {
    throw new TypeError("services must be an array");
  }

  const output = {};
  for (const service of services) {
    if (service.language !== "C#") {
      continue;
    }
    const servicePath = path.resolve(rootPath, service.path);
    if (
      servicePath !== rootPath &&
      !servicePath.startsWith(`${rootPath}${path.sep}`)
    ) {
      throw new Error(`Service path escapes repository: ${service.path}`);
    }
    const files = sourceFiles(servicePath);
    const prefix = odataPrefix(files);
    const entries = [];
    for (const absoluteFile of files) {
      const text = readText(absoluteFile);
      const file = toPosix(path.relative(rootPath, absoluteFile));
      extractControllers(text, file, entries, prefix);
      extractMinimalApis(text, file, entries);
    }
    output[service.name] = { entries: uniqueSorted(entries) };
  }
  return output;
}

function runCli(argv) {
  if (!argv[2] || !argv[3]) {
    console.error(
      "Usage: node scanner/extract-entry-points.js <repo-path> <services-json> [output-file]",
    );
    process.exitCode = 1;
    return;
  }
  try {
    const services = JSON.parse(fs.readFileSync(path.resolve(argv[3]), "utf8"));
    const result = extractEntryPoints(argv[2], services);
    const outputPath = path.resolve(argv[4] || "entry-points.json");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    const count = Object.values(result).reduce(
      (total, service) => total + service.entries.length,
      0,
    );
    console.log(`Identified ${count} ASP.NET entry point(s); wrote ${outputPath}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runCli(process.argv);
}

module.exports = { extractEntryPoints };
