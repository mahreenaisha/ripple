#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { buildStories } = require("./flow-story");

const SCHEMA_VERSION = "1.0.0";
const SOURCE_EXTENSIONS = new Set([
  ".cs", ".go", ".java", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".ts", ".tsx",
]);
const IGNORED_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", ".idea", ".vscode", ".venv", "venv",
  "__pycache__", "node_modules", ".angular", ".next", ".nuxt", ".cache", ".turbo", ".parcel-cache", ".terraform", "vendor", "generated", "dist", "build",
  "bin", "obj", "out", "target", "coverage", "test", "tests", "__tests__",
]);
const CALL_NOISE = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "nameof",
  "super", "base", "this", "Task", "Promise", "console", "Math", "JSON",
  "String", "Object", "Array", "Date", "Ok", "Created", "NotFound",
]);
const MEANINGFUL_BOUNDARIES = new Set(["database", "external", "queue"]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function lineAt(text, offset) {
  return text.slice(0, offset).split(/\r?\n/).length;
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function collectSourceFiles(rootPath, configFiles = []) {
  const files = [];
  const queue = [rootPath];
  while (queue.length) {
    const directory = queue.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
        .filter((entry) => !entry.isSymbolicLink())
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
        queue.push(absolute);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(absolute);
      } else if (entry.isFile() && entry.name.toLowerCase() === "appsettings.json") {
        configFiles.push(absolute);
      }
    }
  }
  return files.sort();
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
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}" && --depth === 0) {
      return { body: text.slice(openOffset + 1, index), end: index };
    }
  }
  return { body: text.slice(openOffset + 1), end: text.length };
}

function pythonBody(text, startOffset) {
  const before = text.slice(0, startOffset);
  const startLine = before.split(/\r?\n/).length;
  const lines = text.split(/\r?\n/);
  const declaration = lines[startLine - 1] || "";
  const indent = declaration.match(/^\s*/)[0].length;
  let end = startLine;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() && line.match(/^\s*/)[0].length <= indent) break;
    end += 1;
  }
  return lines.slice(startLine, end).join("\n");
}

function classRanges(text, extension) {
  const ranges = [];
  const pattern = extension === ".py"
    ? /^(\s*)class\s+([A-Za-z_]\w*)[^\n]*:/gm
    : /\bclass\s+([A-Za-z_]\w*)[^{]*\{/g;
  for (const match of text.matchAll(pattern)) {
    if (extension === ".py") {
      ranges.push({ name: match[2], start: match.index, end: text.length });
    } else {
      const open = match.index + match[0].lastIndexOf("{");
      const body = braceBody(text, open);
      ranges.push({ name: match[1], start: match.index, end: body.end });
    }
  }
  return ranges;
}

function enclosingClass(ranges, offset) {
  return ranges.find((range) => offset >= range.start && offset <= range.end)?.name || "";
}

function parseFunctions(source) {
  const { text, extension } = source;
  const ranges = classRanges(text, extension);
  const patterns = [];
  if ([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"].includes(extension)) {
    patterns.push(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$]\w*)\s*\([^)]*\)\s*\{/g);
    patterns.push(/(?:const|let|var)\s+([A-Za-z_$]\w*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g);
    patterns.push(/(?:async\s+)?([A-Za-z_$]\w*)\s*\([^)]*\)\s*\{/g);
  } else if (extension === ".py") {
    patterns.push(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*:/gm);
  } else if (extension === ".go") {
    patterns.push(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\([^)]*\)[^{]*\{/gm);
  } else if (extension === ".rb") {
    patterns.push(/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)\b/gm);
  } else {
    patterns.push(/\b(?:public|private|protected|internal|static|virtual|override|sealed|async|\s)+(?:[\w.<>,?[\]]+\s+)+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:=>[^{;\n]*;|\{)/g);
  }

  const functions = [];
  const seen = new Set();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      const className = enclosingClass(ranges, match.index);
      const symbol = className ? `${className}.${name}` : name;
      const declarationLine = lineAt(text, match.index);
      const key = `${symbol}\0${declarationLine}`;
      if (seen.has(key) || CALL_NOISE.has(name)) continue;
      seen.add(key);
      const declaration = match[0];
      let body = "";
      if (extension === ".py") {
        body = pythonBody(text, match.index);
      } else if (extension === ".rb") {
        const rest = text.slice(match.index + declaration.length);
        body = rest.slice(0, Math.max(0, rest.search(/^\s*end\b/m)));
      } else if (declaration.includes("{")) {
        body = braceBody(text, match.index + declaration.lastIndexOf("{")).body;
      } else {
        body = declaration;
      }
      functions.push({
        name, className, symbol, body,
        file: source.file,
        line: declarationLine,
        bodyOffset: match.index + declaration.length - body.length,
        source,
      });
    }
  }
  return functions.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function parseRegistrations(sources) {
  const implementations = new Map();
  for (const source of sources) {
    for (const match of source.text.matchAll(/Add(?:Scoped|Singleton|Transient)\s*<\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*>/g)) {
      implementations.set(match[1], match[2]);
    }
  }
  return implementations;
}

function csharpReceiverTypes(source) {
  const types = new Map();
  for (const match of source.text.matchAll(/\b([A-Z][\w.<>]*)\s+(_?[a-z]\w*)/g)) {
    types.set(match[2], match[1]);
  }
  for (const match of source.text.matchAll(/\b(_[a-zA-Z]\w*)\s*=\s*([a-zA-Z]\w*)\s*;/g)) {
    if (types.has(match[2])) types.set(match[1], types.get(match[2]));
  }
  return types;
}

function callsIn(fn) {
  const calls = [];
  const pattern = /(?:(\b[_A-Za-z]\w*)\s*\.\s*)?([A-Za-z_]\w*)\s*(?:<[^;\n()]+>)?\s*\(/g;
  for (const match of fn.body.matchAll(pattern)) {
    const receiver = match[1] || "";
    const name = match[2];
    if (CALL_NOISE.has(name) || /^(Log|get_|set_)/.test(name)) continue;
    const prefix = fn.body.slice(Math.max(0, match.index - 8), match.index);
    if (/\b(?:new|class|function|def)\s*$/.test(prefix)) continue;
    calls.push({
      receiver,
      name,
      expression: receiver ? `${receiver}.${name}` : name,
      arguments: fn.body
        .slice(match.index + match[0].length)
        .match(/^[^)\n]*/)?.[0]?.trim() || "",
      line: fn.line + fn.body.slice(0, match.index).split(/\r?\n/).length - 1,
    });
  }
  return calls;
}

function namedTarget(argumentsText) {
  return argumentsText.match(/["']([^"']{2,80})["']/)?.[1] || "";
}

function boundaryFor(call, caller, receiverTypes) {
  const receiverType = receiverTypes.get(call.receiver) || "";
  const evidenceText = `${call.expression} ${receiverType} ${caller.className} ${caller.file}`;
  const method = call.name;
  const target = namedTarget(call.arguments);
  const result = (kind, label, reason) => ({
    kind,
    label,
    evidence: `${reason}; source call: ${call.expression}${receiverType ? `; receiver type: ${receiverType}` : ""}`,
  });

  if (/DBRepository|Dynamo(?:DB)?|IAmazonDynamoDB/i.test(evidenceText)) {
    return result("database", `DynamoDB via ${call.expression}`, "DynamoDB or DBRepository receiver evidence");
  }
  if (/EntityProvider|OpenSearch/i.test(evidenceText) && /Query|List|Load|Find|Search|Create|Update|Delete|Index|Bulk/i.test(method)) {
    return result("database", `OpenSearch via ${call.expression}`, "EntityProvider/OpenSearch evidence on a data operation");
  }
  if (/(?:Entity|Data)Provider|Repository/i.test(evidenceText) && /Query|List|Load|Find|Search|Get|Create|Add|Save|Update|Delete|Remove|Insert/i.test(method)) {
    return result("database", `data provider via ${call.expression}`, "Provider or repository receiver evidence on a data operation");
  }
  if (/SaveChanges|ExecuteQuery|QueryAsync|FindAsync|(?:repository|database|db)\./i.test(call.expression)) {
    return result("database", `database via ${call.expression}`, "Generic database operation evidence");
  }
  if (/Mqtt/i.test(evidenceText) && /Publish|Send/i.test(method)) {
    return result("external", `MQTT via ${call.expression}`, "MQTT publisher receiver evidence");
  }
  if (/AmazonIot|IAmazonIotData|IoT(?:Data)?Provider/i.test(evidenceText)) {
    return result("external", `AWS IoT via ${call.expression}`, "AWS IoT client or IoT provider receiver evidence");
  }
  if (/Notification(?:Publisher|Client|Provider)|INotification/i.test(evidenceText)) {
    return result("external", `notification service via ${call.expression}`, "Notification client or publisher receiver evidence");
  }
  if (/EventBridge/i.test(evidenceText)) {
    return result("queue", target ? `EventBridge target "${target}"` : `EventBridge via ${call.expression}`, "EventBridge publisher evidence");
  }
  if (/Sqs|SQS|IAmazonSQS/i.test(evidenceText)) {
    return result("queue", target ? `SQS queue "${target}"` : `SQS via ${call.expression}`, "SQS publisher evidence");
  }
  if (/JobQueue|QueuePublisher|Kafka|Rabbit/i.test(evidenceText) && /Publish|Send|Enqueue|Produce/i.test(method)) {
    return result("queue", target ? `queue "${target}"` : `queue via ${call.expression}`, "Queue publisher receiver evidence");
  }
  if (/(?:Http|Api)\w*Client|IHttpClient|httpClient|fetch|axios|grpc/i.test(evidenceText)) {
    return result("external", `HTTP via ${call.expression}`, "HTTP/API client receiver evidence");
  }
  if (/Publish|Enqueue|SendMessage|Produce/i.test(method) && /publisher|queue/i.test(call.receiver)) {
    return result("queue", target ? `queue "${target}"` : `queue via ${call.expression}`, "Generic queue publisher naming evidence");
  }
  return null;
}

function pathUsefulness(pathSteps) {
  const boundary = pathSteps.some((step) => MEANINGFUL_BOUNDARIES.has(step.kind)) ? 1000 : 0;
  const depth = pathSteps.filter((step) => step.kind === "call").length * 20;
  const inferencePenalty = pathSteps.some((step) => step.kind === "inference-limit") ? 500 : 0;
  const trivialPenalty = pathSteps.reduce((total, step) =>
    total + (/Parameter|Accessor|GetKey|GetQuery|Parse|Validate|Helper|Result/i.test(step.symbol) ? 30 : 0), 0);
  return boundary + depth - inferencePenalty - trivialPenalty;
}

function comparePaths(left, right) {
  return pathUsefulness(right) - pathUsefulness(left) ||
    JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function makeStep(kind, symbol, file, line, confidence, evidence, label) {
  return {
    kind,
    symbol,
    label: label || symbol,
    file,
    line,
    confidence,
    evidence: Array.isArray(evidence) ? evidence : [evidence],
  };
}

function routeTriggers(sources) {
  const triggers = [];
  function add(source, match, method, route, handler, evidence) {
    triggers.push({
      type: "api", label: `${method.toUpperCase()} ${route}`, handler,
      file: source.file, line: lineAt(source.text, match.index),
      evidence,
    });
  }
  for (const source of sources) {
    const text = source.text;
    if ([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"].includes(source.extension)) {
      for (const match of text.matchAll(/\b(?:app|router|server)\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*(?:[A-Za-z_$]\w*\s*,\s*)*([A-Za-z_$]\w*)/gi)) {
        add(source, match, match[1], match[2], match[3], "Express-style route registration names the handler");
      }
    } else if (source.extension === ".py") {
      for (const match of text.matchAll(/@(?:app|router|blueprint)\.(get|post|put|patch|delete)\(\s*["']([^"']+)["'][^)]*\)\s*\n\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/g)) {
        add(source, match, match[1], match[2], match[3], "FastAPI/Flask decorator is directly attached to the handler");
      }
    } else if (source.extension === ".go") {
      for (const match of text.matchAll(/\b(?:router|r|engine)\.(GET|POST|PUT|PATCH|DELETE)\(\s*"([^"]+)"\s*,\s*([A-Za-z_]\w*)/g)) {
        add(source, match, match[1], match[2], match[3], "Go router registration names the handler");
      }
      for (const match of text.matchAll(/\bhttp\.HandleFunc\(\s*"([^"]+)"\s*,\s*([A-Za-z_]\w*)/g)) {
        add(source, match, "ANY", match[1], match[2], "net/http registration names the handler");
      }
    } else if (source.extension === ".rb") {
      for (const match of text.matchAll(/^\s*(get|post|put|patch|delete)\s+["']([^"']+)["'][^\n]*\bto:\s*["']([^#]+)#([^"']+)/gmi)) {
        add(source, match, match[1], match[2], match[4], "Ruby route names a controller action");
      }
    }
  }
  return triggers;
}

function entryPointTriggers(functions, entryPoints) {
  const triggers = [];
  for (const [service, value] of Object.entries(entryPoints || {})) {
    for (const entry of value.entries || []) {
      if (!["API", "CLI"].includes(entry.type)) continue;
      const candidates = functions.filter((fn) => fn.file === entry.file);
      let handler = candidates
        .filter((fn) => fn.line >= entry.line)
        .sort((a, b) => a.line - b.line)[0] || candidates[0];
      if (!handler && entry.type === "API") {
        handler = {
          name: "inline-route-handler",
          symbol: "inline-route-handler",
          className: "",
          body: "",
          file: entry.file,
          line: entry.line,
          source: { file: entry.file },
        };
      }
      if (!handler) continue;
      triggers.push({
        type: entry.type === "CLI" ? "cli" : "api",
        label: entry.endpoint,
        handler: handler.symbol,
        handlerFn: handler,
        file: entry.file,
        line: entry.line,
        service,
        evidence: entry.type === "CLI"
          ? "CLI registration evidence is bound to the nearest callable declaration"
          : "Framework entry-point evidence is bound to the nearest callable declaration",
      });
    }
  }
  return triggers;
}

function queueTriggers(sources, functions) {
  const discriminators = [];
  for (const source of sources.filter((item) => item.extension === ".cs")) {
    for (const match of source.text.matchAll(/["']([^"']+)["']\s*=>\s*typeof\s*\(\s*([A-Za-z_]\w*)\s*\)/g)) {
      discriminators.push({
        label: match[1], messageType: match[2], file: source.file,
        line: lineAt(source.text, match.index),
      });
    }
  }
  const handlers = [];
  for (const source of sources.filter((item) => item.extension === ".cs")) {
    for (const match of source.text.matchAll(/\bclass\s+([A-Za-z_]\w*)[\s\S]{0,800}?:[^{;\n]*?(?:MessageHandler|Handler)[A-Za-z_<>]*\s*<\s*([A-Za-z_]\w*)\s*>/g)) {
      const className = match[1];
      const fn = functions.find((item) =>
        item.className === className && /^Handle(?:Message|Async|Request)?/.test(item.name));
      if (fn) handlers.push({ messageType: match[2], fn });
    }
  }
  return discriminators.flatMap((item) => {
    const matches = handlers.filter((handler) => handler.messageType === item.messageType);
    return matches.map((handler) => ({
      type: "queue",
      label: item.label,
      messageType: item.messageType,
      handler: handler.fn.symbol,
      handlerFn: handler.fn,
      file: item.file,
      line: item.line,
      evidence: `Discriminator maps "${item.label}" to ${item.messageType}; handler base declares the same message type`,
    }));
  });
}

function indexFunctions(functions) {
  const index = new Map();
  for (const fn of functions) {
    for (const key of new Set([fn.symbol, fn.name])) {
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(fn);
    }
  }
  return index;
}

function resolveCall(call, caller, index, implementations, receiverTypes) {
  let className = "";
  if (call.receiver) {
    const type = receiverTypes.get(call.receiver);
    className = implementations.get(type) || type || "";
    if (className) {
      const exact = index.get(`${className}.${call.name}`) || [];
      if (exact.length === 1) return { fn: exact[0], confidence: "high", evidence: `Receiver type ${type} resolves to ${className}` };
    }
    const sameClass = index.get(`${caller.className}.${call.name}`) || [];
    if (call.receiver === "this" && sameClass.length === 1) {
      return { fn: sameClass[0], confidence: "high", evidence: "Explicit this-call resolves within the class" };
    }
  } else {
    const sameClass = index.get(`${caller.className}.${call.name}`) || [];
    if (sameClass.length === 1) return { fn: sameClass[0], confidence: "high", evidence: "Unqualified call resolves uniquely within the class" };
  }
  const candidates = index.get(call.name) || [];
  if (candidates.length === 1) {
    return { fn: candidates[0], confidence: "medium", evidence: "Method name has one repository definition" };
  }
  return null;
}

function stableId(service, trigger) {
  const digest = crypto.createHash("sha1")
    .update(`${service}\0${trigger.type}\0${trigger.label}\0${trigger.file}\0${trigger.line}`)
    .digest("hex").slice(0, 12);
  return `flow-${digest}`;
}

function extractRequestFlows(repoPath, services = [], entryPoints = {}, options = {}) {
  const rootPath = path.resolve(repoPath);
  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
    throw new Error(`Repository path is not a directory: ${repoPath}`);
  }
  const limits = {
    max_depth: Number.isInteger(options.maxDepth) ? options.maxDepth : 6,
    max_paths_per_trigger: Number.isInteger(options.maxPathsPerTrigger) ? options.maxPathsPerTrigger : 8,
    max_flows: Number.isInteger(options.maxFlows) ? options.maxFlows : 500,
  };
  const serviceForFile = (file) => {
    const matches = services
      .filter((service) => service.path === "." || file === service.path || file.startsWith(`${service.path}/`))
      .sort((a, b) => b.path.length - a.path.length);
    return matches[0]?.name || "repository";
  };
  const configPaths = [];
  const sources = collectSourceFiles(rootPath, configPaths).map((absolute) => ({
    absolute,
    file: toPosix(path.relative(rootPath, absolute)),
    extension: path.extname(absolute).toLowerCase(),
    text: readText(absolute),
  }));
  const functions = sources.flatMap(parseFunctions);
  const index = indexFunctions(functions);
  const implementations = parseRegistrations(sources);
  const receiverTypesByFile = new Map(sources.map((source) => [source.file, csharpReceiverTypes(source)]));
  const triggers = [
    ...routeTriggers(sources),
    ...entryPointTriggers(functions, entryPoints),
    ...queueTriggers(sources, functions),
  ].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.label.localeCompare(b.label))
    .filter((trigger, index, all) => index === all.findIndex((candidate) =>
      candidate.type === trigger.type &&
      candidate.label === trigger.label &&
      candidate.file === trigger.file &&
      candidate.line === trigger.line));
  const flows = [];
  const warnings = [];

  function pathsFrom(fn, depth, visited) {
    if (depth >= limits.max_depth) {
      return [[makeStep("inference-limit", "depth-limit", fn.file, fn.line, "high", `Traversal stopped at configured depth ${limits.max_depth}`, "Depth limit reached")]];
    }
    const calls = callsIn(fn);
    const paths = [];
    for (const call of calls) {
      const receiverTypes = receiverTypesByFile.get(fn.file) || new Map();
      const boundary = boundaryFor(call, fn, receiverTypes);
      if (boundary) {
        paths.push([makeStep(
          boundary.kind,
          call.expression,
          fn.file,
          call.line,
          "medium",
          boundary.evidence,
          boundary.label,
        )]);
        continue;
      }
      const resolved = resolveCall(
        call, fn, index, implementations,
        receiverTypes,
      );
      if (!resolved || visited.has(`${resolved.fn.file}:${resolved.fn.line}`)) continue;
      const step = makeStep(
        "call", resolved.fn.symbol, resolved.fn.file, resolved.fn.line,
        resolved.confidence, resolved.evidence,
      );
      const nested = pathsFrom(
        resolved.fn, depth + 1,
        new Set([...visited, `${resolved.fn.file}:${resolved.fn.line}`]),
      );
      if (nested.length) nested.forEach((tail) => paths.push([step, ...tail]));
      else paths.push([step]);
    }
    return paths.sort(comparePaths).slice(0, limits.max_paths_per_trigger);
  }

  for (const trigger of triggers) {
    if (flows.length >= limits.max_flows) break;
    const handler = trigger.handlerFn ||
      (index.get(trigger.handler) || []).find((fn) => fn.file === trigger.file) ||
      (index.get(trigger.handler) || [])[0];
    if (!handler) {
      warnings.push({
        code: "unresolved-handler",
        message: `Could not resolve handler "${trigger.handler}" for ${trigger.label}`,
        file: trigger.file,
        line: trigger.line,
      });
      continue;
    }
    const triggerStep = makeStep(
      trigger.type === "queue" ? "queue-trigger" : trigger.type === "cli" ? "cli-trigger" : "api-trigger",
      trigger.label, trigger.file, trigger.line, "high", trigger.evidence,
    );
    const handlerStep = makeStep(
      "handler", handler.symbol, handler.file, handler.line, "high",
      trigger.type === "queue"
        ? "Message type evidence binds the queue event to this handler"
        : trigger.type === "cli"
          ? "CLI registration evidence binds this handler"
          : "Route registration or controller annotation binds this handler",
    );
    const tails = pathsFrom(handler, 1, new Set([`${handler.file}:${handler.line}`]));
    const paths = (tails.length ? tails : [[]]).sort(comparePaths);
    const primary = paths[0];
    const alternatives = paths.slice(1);
    const service = trigger.service || serviceForFile(trigger.file);
    const flow = {
      id: stableId(service, trigger),
      service,
      trigger: {
        kind: trigger.type,
        label: trigger.label,
        ...(trigger.messageType ? { message_type: trigger.messageType } : {}),
      },
      confidence: primary.some((step) => step.confidence === "medium") ? "medium" : "high",
      steps: [triggerStep, handlerStep, ...primary],
    };
    if (alternatives.length) {
      flow.branches = alternatives.map((tail) => [triggerStep, handlerStep, ...tail]);
    }
    flows.push(flow);
  }
  buildStories(flows, {
    sources,
    functions,
    configFiles: configPaths.map((absolute) => ({
      absolute,
      file: toPosix(path.relative(rootPath, absolute)),
    })),
  });
  if (flows.length >= limits.max_flows) {
    warnings.push({
      code: "flow-cap-reached",
      message: `Output stopped at the configured maximum of ${limits.max_flows} flows`,
      file: null,
      line: null,
    });
  }

  return {
    schema_version: SCHEMA_VERSION,
    generator: {
      name: "ripple-request-flow-scanner",
      deterministic: true,
      strategy: "static-evidence-heuristics",
    },
    limits,
    flows,
    warnings: warnings.sort((a, b) =>
      String(a.file).localeCompare(String(b.file)) || (a.line || 0) - (b.line || 0)),
    glossary: {
      flow: "One evidence-backed path from an entry point toward a meaningful boundary.",
      trigger: "The API route, CLI command, or queue message that starts work.",
      API: "An application programming interface exposed for another program to call.",
      OData: "A standard for querying and changing data through HTTP APIs.",
      cli: "A command-line command registered by the application.",
      handler: "The first function or method directly bound to a trigger.",
      call: "A direct source-code call whose target was resolved heuristically.",
      database: "A call that appears to cross into persistent storage; traversal stops here.",
      external: "A call that appears to leave the process over a network client; traversal stops here.",
      queue: "A publish or enqueue call; downstream processing is a separate flow.",
      tenant: "A customer or organizational boundary whose data and configuration are isolated.",
      adapter: "Code that translates between an application-facing interface and an external technology.",
      provider: "A component that supplies data or operations behind an interface.",
      port: "An application-owned interface through which core logic communicates with adapters.",
      "entity provider": "A provider that loads or stores domain entities, often through a search or database system.",
      OpenSearch: "A search and document-storage engine; named only when matching source or type evidence exists.",
      "IoT thing": "A cloud representation of a physical or logical Internet of Things device.",
      Greengrass: "AWS edge software used to deploy and run workloads near IoT devices.",
      SQS: "Amazon Simple Queue Service, used for asynchronous message delivery.",
      EventBridge: "An AWS event bus used to route events between producers and consumers.",
      MQTT: "A lightweight publish/subscribe protocol commonly used by IoT devices.",
      SPOF: "Single point of failure: one component whose loss can stop a larger workflow.",
      confidence: "High means direct binding or unique typed resolution; medium means a conservative naming heuristic.",
      evidence: "The concrete source relationship supporting a step. It is not runtime proof.",
      warning: "A place where evidence was insufficient or an output safety limit was reached.",
    },
  };
}

function runCli(argv) {
  if (!argv[2]) {
    console.error("Usage: node scanner/extract-request-flows.js <repo-path> [services-json] [entry-points-json] [output-file]");
    process.exitCode = 1;
    return;
  }
  try {
    const services = argv[3] ? JSON.parse(fs.readFileSync(path.resolve(argv[3]), "utf8")) : [];
    const entryPoints = argv[4] ? JSON.parse(fs.readFileSync(path.resolve(argv[4]), "utf8")) : {};
    const outputPath = path.resolve(argv[5] || "request-flows.json");
    const result = extractRequestFlows(argv[2], services, entryPoints);
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
