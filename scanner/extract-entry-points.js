#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");

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
  "node_modules",
  ".angular",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".parcel-cache",
  ".terraform",
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
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".ts",
  ".tsx",
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
        SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        files.push(absolutePath);
      }
    }
  }
  return files;
}

function addEntry(entries, type, endpoint, file, line) {
  if (!endpoint) {
    return;
  }
  entries.push({ type, endpoint: endpoint.trim(), file, line });
}

function joinRoute(prefix, route) {
  const parts = [prefix, route]
    .filter(Boolean)
    .map((part) => String(part).replace(/^\/+|\/+$/g, ""));
  return `/${parts.join("/")}`.replace(/\/+/g, "/");
}

function extractNode(text, file, entries, includeExports) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const match of line.matchAll(
      /\b(?:app|router|server)\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
    )) {
      addEntry(entries, "API", `${match[1].toUpperCase()} ${match[2]}`, file, index + 1);
    }
    for (const match of line.matchAll(
      /\b(?:yargs(?:\([^)]*\))?|program)\s*\.\s*command\s*\(\s*["'`]([^"'`]+)["'`]/gi,
    )) {
      addEntry(entries, "CLI", match[1], file, index + 1);
    }
    if (!includeExports) {
      return;
    }
    const declaration = line.match(
      /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/,
    );
    if (declaration) {
      addEntry(entries, "export", declaration[1], file, index + 1);
    }
    for (const match of line.matchAll(
      /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    )) {
      addEntry(entries, "export", match[1], file, index + 1);
    }
    for (const match of line.matchAll(
      /\b(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g,
    )) {
      addEntry(entries, "export", match[1], file, index + 1);
    }
    const objectExport = line.match(/\bmodule\.exports\s*=\s*\{([^}]*)\}/);
    if (objectExport) {
      for (const item of objectExport[1].split(",")) {
        const name = item.trim().match(/^([A-Za-z_$][\w$]*)/)?.[1];
        addEntry(entries, "export", name, file, index + 1);
      }
    }
  });
}

function extractPython(text, file, entries, includeExports) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    let match = line.match(
      /@(?:app|router|blueprint)\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/i,
    );
    if (match) {
      addEntry(entries, "API", `${match[1].toUpperCase()} ${match[2]}`, file, index + 1);
    }

    match = line.match(/@(?:app|blueprint)\.route\(\s*["']([^"']+)["'](.*)\)/i);
    if (match) {
      const methods = [...match[2].matchAll(/["']([A-Z]+)["']/g)].map(
        (item) => item[1],
      );
      for (const method of methods.length > 0 ? methods : ["ANY"]) {
        addEntry(entries, "API", `${method} ${match[1]}`, file, index + 1);
      }
    }

    match = line.match(/@(?:click\.)?(?:command|group)\(\s*(?:name\s*=\s*)?["']([^"']+)["']/i);
    if (match) {
      addEntry(entries, "CLI", match[1], file, index + 1);
    }
    for (const parser of line.matchAll(/\.add_parser\(\s*["']([^"']+)["']/g)) {
      addEntry(entries, "CLI", parser[1], file, index + 1);
    }

    if (includeExports) {
      const declaration = line.match(
        /^(?:async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/,
      );
      if (declaration) {
        addEntry(entries, "export", declaration[1], file, index + 1);
      }
      const exported = line.match(/^__all__\s*=\s*\[([^\]]*)\]/);
      if (exported) {
        for (const name of exported[1].matchAll(/["']([^"']+)["']/g)) {
          addEntry(entries, "export", name[1], file, index + 1);
        }
      }
    }
  });
}

function extractGo(text, file, entries, includeExports) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const match of line.matchAll(
      /\b(?:router|r|engine)\.(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\(\s*"([^"]+)"/g,
    )) {
      addEntry(entries, "API", `${match[1]} ${match[2]}`, file, index + 1);
    }
    for (const match of line.matchAll(/\bhttp\.HandleFunc\(\s*"([^"]+)"/g)) {
      addEntry(entries, "API", `ANY ${match[1]}`, file, index + 1);
    }
    const cobra = line.match(/\bUse\s*:\s*"([^"]+)"/);
    if (cobra) {
      addEntry(entries, "CLI", cobra[1].split(/\s+/)[0], file, index + 1);
    }
    if (includeExports) {
      const exported = line.match(
        /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
      );
      if (exported) {
        addEntry(entries, "export", exported[1], file, index + 1);
      }
    }
  });
}

function extractJava(text, file, entries, includeExports) {
  const lines = text.split(/\r?\n/);
  let classPrefix = "";
  let className = "";
  let pendingMappings = [];

  lines.forEach((line, index) => {
    const mappingPattern =
      /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\s*(?:\(\s*(?:value\s*=\s*)?["']([^"']*)["']([^)]*)\))?/g;
    for (const match of line.matchAll(mappingPattern)) {
      const annotation = match[1];
      let method = annotation.replace("Mapping", "").toUpperCase();
      if (annotation === "RequestMapping") {
        method =
          match[3]?.match(/RequestMethod\.([A-Z]+)/)?.[1] || "ANY";
      }
      pendingMappings.push({ method, route: match[2] || "", line: index + 1 });
    }

    const classDeclaration = line.match(/\bclass\s+(\w+)/);
    if (classDeclaration) {
      className = classDeclaration[1];
      const classMapping = pendingMappings.find((mapping) => mapping.method === "ANY");
      classPrefix = classMapping?.route || "";
      pendingMappings = [];
      return;
    }

    const method = line.match(
      /^\s*(?:(public|protected|private)\s+)?(?:static\s+)?(?:[\w<>,?[\].]+\s+)+(\w+)\s*\([^;]*\)/,
    );
    if (method) {
      for (const mapping of pendingMappings) {
        addEntry(
          entries,
          "API",
          `${mapping.method} ${joinRoute(classPrefix, mapping.route)}`,
          file,
          mapping.line,
        );
      }
      if (includeExports && method[2] !== className) {
        addEntry(entries, "export", `${className}.${method[2]}`, file, index + 1);
      }
      pendingMappings = [];
    }
  });
}

function extractRuby(text, file, entries, includeExports) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    let match = line.match(/^\s*(get|post|put|patch|delete)\s+["']([^"']+)["']/i);
    if (match) {
      addEntry(entries, "API", `${match[1].toUpperCase()} ${match[2]}`, file, index + 1);
    }
    match = line.match(/^\s*desc\s+["']([^"']+)["']/);
    if (match) {
      addEntry(entries, "CLI", match[1].split(/\s+/)[0], file, index + 1);
    }
    if (includeExports) {
      const method = line.match(/^\s*def\s+(?:self\.)?([A-Za-z_][A-Za-z0-9_!?=]*)/);
      if (method) {
        addEntry(entries, "export", method[1], file, index + 1);
      }
    }
  });
}

function csharpODataPrefix(allFiles) {
  for (const filePath of allFiles) {
    const text = readText(filePath);
    const match = text.match(/Add\w*OData\([\s\S]{0,300}?["']([^"']+)["']/);
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

function odataEndpoint(prefix, controllerName, methodName, explicitVerb, hasKey = false) {
  const entitySet = controllerName.replace(/Controller$/, "");
  const base = joinRoute(prefix, entitySet);
  const verbFromName = methodName.match(/^(Get|Post|Put|Patch|Delete)/)?.[1]?.toUpperCase();
  const verb = explicitVerb || verbFromName;
  if (!verb) {
    return null;
  }

  if (methodName === "Get") {
    return `${verb} ${base}`;
  }
  const action = methodName.match(new RegExp(`^(.+?)On(?:${entitySet.replace(/s$/, "")})?$`));
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

function extractCsharp(text, file, entries, odataPrefix, serviceName, includeExports) {
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
    const methodName = method.name;
    if (includeExports) {
      addEntry(entries, "export", `${className}.${methodName}`, file, index + 1);
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
          "API",
          `${verb} ${joinRoute(classRoute, attribute.route)}`,
          file,
          attribute.line,
        );
      } else if (isODataController && odataPrefix) {
        addEntry(
          entries,
          "API",
          odataEndpoint(odataPrefix, className, methodName, verb, hasKey),
          file,
          attribute.line,
        );
      }
    }
    if (httpAttributes.length === 0 && isODataController && odataPrefix) {
      addEntry(
        entries,
        "API",
        odataEndpoint(odataPrefix, className, methodName),
        file,
        index + 1,
      );
    }
    pendingAttributes = [];
  });

  lines.forEach((line, index) => {
    for (const route of line.matchAll(
      /\.Map(Get|Post|Put|Patch|Delete)\(\s*["']([^"']+)["']/g,
    )) {
      addEntry(
        entries,
        "API",
        `${route[1].toUpperCase()} ${route[2]}`,
        file,
        index + 1,
      );
    }
    const health = line.match(/\.MapHealthChecks\(\s*["']([^"']+)["']/);
    if (health) {
      addEntry(entries, "API", `GET ${health[1]}`, file, index + 1);
    }
    const command = line.match(
      /\bnew\s+(?:RootCommand|Command)\s*\(\s*["']([^"']+)["']/,
    );
    if (command) {
      addEntry(entries, "CLI", command[1], file, index + 1);
    }
    const namedCommand = text.match(
      /const\s+string\s+COMMAND_NAME\s*=\s*["']([^"']+)["']/,
    );
    if (
      namedCommand &&
      line.includes("UtilityCommand(COMMAND_NAME")
    ) {
      addEntry(entries, "CLI", namedCommand[1], file, index + 1);
    }
    if (/\bnew\s+RootCommand\s*\(/.test(line) && !/["']/.test(line)) {
      addEntry(entries, "CLI", serviceName, file, index + 1);
    }
  });
}

function uniqueSorted(entries) {
  const seen = new Set();
  return entries
    .filter((entry) => {
      const key = `${entry.type}\0${entry.endpoint}\0${entry.file}\0${entry.line}`;
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
    const servicePath = path.resolve(rootPath, service.path);
    if (
      !servicePath.startsWith(`${rootPath}${path.sep}`) &&
      servicePath !== rootPath
    ) {
      throw new Error(`Service path escapes repository: ${service.path}`);
    }

    const files = sourceFiles(servicePath);
    const entries = [];
    // Keep all callable module/package symbols for now. Later stages can filter
    // internal symbols without requiring a second repository scan.
    const includeExports = true;
    const odataPrefix = service.language === "C#" ? csharpODataPrefix(files) : null;

    for (const absoluteFile of files) {
      const text = readText(absoluteFile);
      const file = toPosix(path.relative(rootPath, absoluteFile));
      const extension = path.extname(absoluteFile).toLowerCase();
      if ([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"].includes(extension)) {
        extractNode(text, file, entries, includeExports);
      } else if (extension === ".py") {
        extractPython(text, file, entries, includeExports);
      } else if (extension === ".go") {
        extractGo(text, file, entries, includeExports);
      } else if (extension === ".java") {
        extractJava(text, file, entries, includeExports);
      } else if (extension === ".rb") {
        extractRuby(text, file, entries, includeExports);
      } else if (extension === ".cs") {
        extractCsharp(
          text,
          file,
          entries,
          odataPrefix,
          service.name,
          includeExports,
        );
      }
    }
    if (
      ["cli", "job", "init-container"].includes(service.kind) &&
      !entries.some(
        (entry) => entry.type === "CLI" && entry.endpoint === service.name,
      )
    ) {
      const entryPath = path.resolve(rootPath, service.entry_file || "");
      const entryText = readText(entryPath);
      const mainLine = entryText
        .split(/\r?\n/)
        .findIndex((line) => /\bMain\s*\(/.test(line));
      if (mainLine >= 0) {
        addEntry(
          entries,
          "CLI",
          service.name,
          toPosix(path.relative(rootPath, entryPath)),
          mainLine + 1,
        );
      }
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
    const outputPath = path.resolve(argv[4] || "entry-points.json");
    const result = extractEntryPoints(argv[2], services);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    const count = Object.values(result).reduce(
      (total, service) => total + service.entries.length,
      0,
    );
    console.log(`Identified ${count} entry point(s); wrote ${outputPath}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runCli(process.argv);
}

module.exports = { extractEntryPoints };
