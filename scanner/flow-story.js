"use strict";

const fs = require("node:fs");

const BACKGROUND_PATTERN = /Heartbeat|Background|Cleanup|Renewal|Expir|Schedul|Timer|Periodic|Cron|Sweep|Purge|Reconcil/i;
const DEVICE_PATTERN = /Device|Controller|Status|Connectivity|Onboard|Metrics|System|GG|Iot|Mqtt|Greengrass/i;
const OWNER_SUFFIX = /(Messages|Events|Contracts|Commands)$/;
const KEYWORD_STOPWORDS = new Set([
  "tenancy", "tenant", "devices", "device", "message", "messages", "request",
  "handler", "update", "updated", "event", "events", "created", "deleted",
  "validator", "provider", "adapter", "service", "controller", "system", "systems",
]);
const WRITE_METHOD = /Update|Create|Delete|Remove|Index|Bulk|Save|Insert|Add|Upsert|Put|Write|Publish|Send/i;
const METRIC_CALL = /\b(?:_?\w*[Mm]etric\w*|_?statsd|_?dogStatsd)\s*\.\s*(Histogram|Increment|Decrement|Gauge|Count|Counter|Timing|Distribution|Set)\s*\(\s*(\w+|"[^"]+")/g;
const DURATION_KEY = /(Interval|Delay|Period|Timeout|Frequency|Cadence|Every|Ttl|Expiry|Lifetime)(Seconds|Minutes|Ms|Milliseconds|Hours|InSeconds|InMinutes)?$/i;
const TIMESPAN_VALUE = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?$/;

function cleanDoc(text) {
  return text
    .replace(/<see\s+(?:cref|langword|href)="(?:[A-Z]:)?([^"]+)"\s*\/>/g, (_, ref) => ref.split(".").pop())
    .replace(/<paramref\s+name="([^"]+)"\s*\/>/g, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?(?:c|b|i|para|code|list|item|description|term)[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}

function skipBalanced(text, start, open, close) {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === open) depth += 1;
    else if (text[index] === close && --depth === 0) return index + 1;
  }
  return text.length;
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "<" || char === "(") depth += 1;
    else if (char === ">" || char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function bodyEnd(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}" && --depth === 0) return index;
  }
  return text.length;
}

/**
 * One pass over C# sources: type declarations, their base types, primary
 * constructor parameters, class text, and XML doc summaries for types and members.
 */
function indexCsharp(sources) {
  const types = new Map();
  const typeDocs = new Map();
  const memberDocs = new Map();
  const implementers = new Map();
  const namespaces = new Set();

  for (const source of sources) {
    if (source.extension !== ".cs") continue;
    const { text } = source;
    for (const match of text.matchAll(/^\s*namespace\s+([\w.]+)/gm)) namespaces.add(match[1]);
    const usings = [...text.matchAll(/^\s*using\s+(?!static\b)([\w.]+)\s*;/gm)].map((match) => match[1]);

    const ranges = [];
    for (const match of text.matchAll(/\b(class|interface|record|struct)\s+([A-Za-z_]\w*)/g)) {
      let cursor = match.index + match[0].length;
      if (text[cursor] === "<") cursor = skipBalanced(text, cursor, "<", ">");
      let primaryParams = "";
      const afterName = text.slice(cursor).match(/^\s*\(/);
      if (afterName) {
        const open = cursor + afterName[0].length - 1;
        const close = skipBalanced(text, open, "(", ")");
        primaryParams = text.slice(open + 1, close - 1);
        cursor = close;
      }
      const brace = text.indexOf("{", cursor);
      const semicolon = text.indexOf(";", cursor);
      if (brace === -1 || (semicolon !== -1 && semicolon < brace)) continue;
      const header = text.slice(cursor, brace);
      const baseList = header.match(/:\s*([\s\S]*?)(?:\bwhere\b|$)/)?.[1] || "";
      const bases = splitTopLevel(baseList).map((base) => base.replace(/\(.*$/s, "").replace(/<.*$/s, "").trim());
      const end = bodyEnd(text, brace);
      const name = match[2];
      const entry = {
        name,
        kind: match[1],
        bases,
        primaryParams,
        text: text.slice(match.index, end + 1),
        file: source.file,
        line: text.slice(0, match.index).split(/\r?\n/).length,
        usings,
        start: match.index,
        end,
      };
      ranges.push(entry);
      if (!types.has(name)) types.set(name, entry);
      for (const base of bases) {
        if (!implementers.has(base)) implementers.set(base, []);
        if (!implementers.get(base).includes(name)) implementers.get(base).push(name);
      }
    }

    const enclosing = (offset) => ranges
      .filter((range) => offset > range.start && offset < range.end)
      .sort((a, b) => b.start - a.start)[0]?.name || "";

    const docPattern = /((?:^[ \t]*\/\/\/[^\n]*\n)+)((?:[ \t]*\[[^\n]*\]\s*\n)*)([^\n]*)/gm;
    for (const match of text.matchAll(docPattern)) {
      const raw = match[1].replace(/^[ \t]*\/\/\/ ?/gm, "");
      const inherit = /<inheritdoc/i.test(raw);
      const summary = raw.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1];
      const doc = { text: summary ? cleanDoc(summary) : "", inherit };
      if (!doc.text && !inherit) continue;
      const declaration = match[3];
      const typeMatch = declaration.match(/\b(?:class|interface|record|struct|enum)\s+([A-Za-z_]\w*)/);
      if (typeMatch) {
        if (doc.text && !typeDocs.has(typeMatch[1])) typeDocs.set(typeMatch[1], doc.text);
        continue;
      }
      const memberMatch = declaration.match(/([A-Za-z_]\w*)\s*(?:<[^<>()]*>)?\s*\(/);
      if (!memberMatch) continue;
      const owner = enclosing(match.index + match[1].length);
      if (!owner) continue;
      const key = `${owner}.${memberMatch[1]}`;
      if (!memberDocs.has(key)) memberDocs.set(key, doc);
    }
  }

  return { types, typeDocs, memberDocs, implementers, namespaces };
}

function interfacesOf(csharp, className) {
  const entry = csharp.types.get(className);
  const bases = entry ? entry.bases : [];
  const guessed = `I${className}`;
  return [...new Set([...bases.filter((base) => /^I[A-Z]/.test(base)), guessed])];
}

function memberDoc(csharp, symbol) {
  const dot = symbol.lastIndexOf(".");
  if (dot === -1) return "";
  const className = symbol.slice(0, dot);
  const method = symbol.slice(dot + 1);
  const own = csharp.memberDocs.get(symbol);
  if (own?.text) return own.text;
  for (const iface of interfacesOf(csharp, className)) {
    const inherited = csharp.memberDocs.get(`${iface}.${method}`);
    if (inherited?.text) return inherited.text;
  }
  return "";
}

function typeDoc(csharp, className) {
  if (csharp.typeDocs.has(className)) return csharp.typeDocs.get(className);
  for (const iface of interfacesOf(csharp, className)) {
    if (csharp.typeDocs.has(iface)) return csharp.typeDocs.get(iface);
  }
  return "";
}

function firstSentences(text, count = 2) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  return sentences.slice(0, count).map((sentence) => sentence.trim()).join(" ");
}

const TOUCH_RULES = [
  { kind: "database", system: "OpenSearch", pattern: /OpenSearch|EntityProvider/ },
  { kind: "database", system: "DynamoDB", pattern: /DynamoDB|DBRepository/ },
  { kind: "external", system: "AWS IoT", pattern: /\bI?Iot\w*Provider|AmazonIot|Greengrass/ },
  { kind: "queue", system: "SQS", pattern: /Sqs|QueuePublisher|ErrorPublisher/ },
  { kind: "external", system: "notification service", pattern: /Notification(?:Publisher|Client|Provider|Eventing)/ },
];

function touches(entry) {
  const text = `${entry.usings.join(" ")} ${entry.primaryParams} ${entry.text.slice(0, 4000)}`;
  return TOUCH_RULES.filter((rule) => rule.pattern.test(text)).map(({ kind, system }) => ({ kind, system }));
}

function humanize(name) {
  return name
    .replace(/^I(?=[A-Z])/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/^./, (char) => char.toUpperCase());
}

function words(value) {
  return (value.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) || [])
    .map((word) => word.toLowerCase())
    .filter((word) => word.length >= 5 && !KEYWORD_STOPWORDS.has(word));
}

function classOf(symbol) {
  const dot = symbol.lastIndexOf(".");
  return dot === -1 ? "" : symbol.slice(0, dot);
}

function selfName(csharp, service) {
  const counts = new Map();
  for (const namespace of csharp.namespaces) {
    for (const segment of namespace.split(".")) {
      if (/^[A-Z]\w*AS$/.test(segment)) counts.set(segment, (counts.get(segment) || 0) + 1);
    }
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return best || service.split(".").pop() || service;
}

function repoOwnsNamespace(csharp, namespace) {
  if (csharp.namespaces.has(namespace)) return true;
  return [...csharp.namespaces].some((own) => namespace.startsWith(`${own}.`));
}

function outsideOwner(csharp, usings) {
  const usesAsSuffix = [...csharp.namespaces].some((namespace) =>
    namespace.split(".").some((segment) => /^[A-Z]\w*AS$/.test(segment)));
  for (const namespace of usings) {
    if (repoOwnsNamespace(csharp, namespace)) continue;
    const segment = namespace.split(".").find((part) => OWNER_SUFFIX.test(part) && part.replace(OWNER_SUFFIX, ""));
    if (!segment) continue;
    const owner = segment.replace(OWNER_SUFFIX, "");
    return { namespace, ownerHint: usesAsSuffix ? `${owner}AS` : owner };
  }
  return null;
}

function triggeredBy(flow, context) {
  const { csharp, functions } = context;
  const kind = flow.trigger.kind;
  if (kind === "api") {
    return {
      kind: "http",
      label: "An HTTP client, such as the web UI or another service",
      outsideRepo: true,
      evidence: `Route ${flow.trigger.label}`,
    };
  }
  if (kind === "cli") {
    return {
      kind: "cli",
      label: "An engineer or pipeline running the command",
      outsideRepo: true,
      evidence: `CLI command ${flow.trigger.label}`,
    };
  }
  const messageType = flow.trigger.message_type || flow.trigger.label;
  if (csharp.types.has(messageType)) {
    const creation = new RegExp(`\\bnew\\s+${messageType}\\s*[({]`);
    const definedIn = csharp.types.get(messageType).file;
    const publishers = functions
      .filter((fn) => fn.file !== definedIn && creation.test(fn.body))
      .map((fn) => ({ symbol: fn.symbol, file: fn.file, line: fn.line }))
      .slice(0, 3);
    return {
      kind: "message",
      messageType,
      outsideRepo: false,
      label: publishers.length
        ? `This repo publishes it from ${publishers.map((item) => item.symbol).join(", ")}`
        : "Defined in this repo; no publisher was found by static search",
      publishers,
      evidence: `Message type ${messageType} is declared in ${definedIn}`,
    };
  }
  const handlerFile = flow.steps[1]?.file;
  const usings = [...new Set([
    ...(context.usingsByFile.get(handlerFile) || []),
    ...(context.usingsByFile.get(flow.steps[0]?.file) || []),
  ])];
  const owner = outsideOwner(csharp, usings);
  return {
    kind: "message",
    messageType,
    outsideRepo: true,
    ownerHint: owner?.ownerHint || null,
    namespace: owner?.namespace || null,
    label: owner
      ? `Sent by ${owner.ownerHint}, outside this repo`
      : "Sent by another service; the message type is defined outside this repo",
    evidence: owner
      ? `${messageType} is not declared in this repo; the handler imports ${owner.namespace}`
      : `${messageType} is not declared in this repo`,
  };
}

function category(flow, trigger) {
  if (flow.trigger.kind === "api") return "user-request";
  if (flow.trigger.kind === "cli") return "cli-tool";
  const text = `${flow.trigger.label} ${flow.steps[1]?.symbol || ""}`;
  if (BACKGROUND_PATTERN.test(text)) return "background-job";
  if (DEVICE_PATTERN.test(text)) return "device-event";
  return trigger.outsideRepo ? "platform-event" : "background-job";
}

function fanOut(flow, csharp) {
  const groups = [];
  const seen = new Set();
  for (const step of flow.steps) {
    const className = classOf(step.symbol);
    const entry = csharp.types.get(className);
    if (!entry) continue;
    const text = `${entry.primaryParams}\n${entry.text}`;
    for (const match of text.matchAll(/\bIEnumerable\s*<\s*([A-Za-z_]\w*)\s*>/g)) {
      const iface = match[1];
      if (seen.has(iface)) continue;
      seen.add(iface);
      const members = (csharp.implementers.get(iface) || [])
        .filter((name) => csharp.types.get(name)?.kind === "class")
        .sort()
        .map((name) => {
          const type = csharp.types.get(name);
          const suffix = iface.replace(/^I(?=[A-Z])/, "");
          return {
            name,
            label: humanize(name.endsWith(suffix) && name !== suffix ? name.slice(0, -suffix.length) : name),
            summary: firstSentences(typeDoc(csharp, name) || memberDoc(csharp, `${name}.Validate`), 1),
            touches: touches(type),
            file: type.file,
            line: type.line,
          };
        });
      if (members.length) {
        groups.push({
          via: className,
          interface: iface,
          label: `${className} runs every ${iface}`,
          members,
          evidence: `${className} receives IEnumerable<${iface}>; ${members.length} class(es) in this repo implement ${iface}`,
        });
      }
    }
  }
  return groups;
}

function metrics(flow, csharp) {
  const found = [];
  const seen = new Set();
  for (const className of new Set(flow.steps.map((step) => classOf(step.symbol)).filter(Boolean))) {
    const entry = csharp.types.get(className);
    if (!entry) continue;
    const constants = new Map(
      [...entry.text.matchAll(/\bconst\s+string\s+(\w+)\s*=\s*"([^"]+)"/g)].map((match) => [match[1], match[2]]),
    );
    for (const match of entry.text.matchAll(METRIC_CALL)) {
      const raw = match[2];
      const name = raw.startsWith('"') ? raw.slice(1, -1) : constants.get(raw);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      found.push({
        name,
        type: match[1].toLowerCase(),
        file: entry.file,
        line: entry.line + entry.text.slice(0, match.index).split(/\r?\n/).length - 1,
      });
    }
  }
  return found;
}

function boundaries(flow, fanOutGroups = []) {
  const found = new Map();
  for (const group of fanOutGroups) {
    for (const member of group.members) {
      for (const touch of member.touches) {
        const key = `${touch.kind}\0${touch.system}`;
        const current = found.get(key) || { kind: touch.kind, system: touch.system, access: "check", calls: [] };
        if (current.calls.length < 4) current.calls.push(member.name);
        found.set(key, current);
      }
    }
  }
  for (const path of [flow.steps, ...(flow.branches || [])]) {
    for (const step of path) {
      if (!["database", "external", "queue"].includes(step.kind)) continue;
      const method = step.symbol.split(".").pop();
      const system = step.label.replace(/\s+via\s+.*$/, "").replace(/^(SQS queue|queue|EventBridge target)\s+"(.+)"$/, "$1 $2");
      const key = `${step.kind}\0${system}`;
      const access = step.kind === "database" ? (WRITE_METHOD.test(method) ? "write" : "read") : "send";
      const current = found.get(key) || { kind: step.kind, system, access, calls: [] };
      if (access === "write") current.access = "write";
      else if (current.access === "check") current.access = access;
      if (current.calls.length < 4 && !current.calls.includes(step.symbol)) current.calls.push(step.symbol);
      found.set(key, current);
    }
  }
  return [...found.values()];
}

function flattenJson(value, prefix = []) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, child]) => flattenJson(child, [...prefix, key]));
  }
  return [{ path: prefix, value }];
}

function humanDuration(value, key) {
  const span = String(value).match(TIMESPAN_VALUE);
  let seconds = null;
  if (span) {
    seconds = Number(span[1] || 0) * 86400 + Number(span[2]) * 3600 + Number(span[3]) * 60 + Number(span[4]);
  } else if (typeof value === "number") {
    const unit = key.match(/(Milliseconds|Ms|Seconds|Minutes|Hours|Days|Months)/)?.[1]?.toLowerCase() || "";
    if (unit === "months") return `${value} month${value === 1 ? "" : "s"}`;
    if (unit === "ms" || unit === "milliseconds") seconds = value / 1000;
    else if (unit === "minutes") seconds = value * 60;
    else if (unit === "hours") seconds = value * 3600;
    else if (unit === "days") seconds = value * 86400;
    else if (unit === "seconds") seconds = value;
  }
  if (seconds === null) return String(value);
  const units = [["day", 86400], ["hour", 3600], ["minute", 60], ["second", 1]];
  for (const [unit, size] of units) {
    if (seconds >= size && seconds % size === 0) {
      const amount = seconds / size;
      return `${amount} ${unit}${amount === 1 ? "" : "s"}`;
    }
  }
  return `${seconds} seconds`;
}

function loadSettings(configFiles) {
  const settings = [];
  for (const config of configFiles) {
    let text = "";
    try {
      text = fs.readFileSync(config.absolute, "utf8");
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/, "").replace(/^\s*\/\/.*$/gm, ""));
    } catch {
      continue;
    }
    for (const entry of flattenJson(parsed)) {
      const key = entry.path[entry.path.length - 1] || "";
      const isSpan = typeof entry.value === "string" && TIMESPAN_VALUE.test(entry.value);
      const isNumericDuration = typeof entry.value === "number" && DURATION_KEY.test(key);
      if (!isSpan && !isNumericDuration) continue;
      const index = text.indexOf(`"${key}"`);
      settings.push({
        key: entry.path.join(":"),
        value: entry.value,
        human: humanDuration(entry.value, key),
        file: config.file,
        line: index === -1 ? 1 : text.slice(0, index).split(/\r?\n/).length,
      });
    }
  }
  return settings;
}

function timing(flow, settings, fanOutGroups) {
  const keywords = new Set([
    ...words(flow.trigger.label),
    ...words(classOf(flow.steps[1]?.symbol || "")),
    ...fanOutGroups.flatMap((group) => group.members.flatMap((member) => words(member.name))),
  ]);
  if (!keywords.size) return [];
  return settings
    .filter((setting) => [...keywords].some((word) => setting.key.toLowerCase().includes(word)))
    .slice(0, 6);
}

function purposeFor(flow, csharp) {
  for (const step of flow.steps) {
    if (!["handler", "call"].includes(step.kind)) continue;
    const doc = memberDoc(csharp, step.symbol);
    if (doc) return { text: firstSentences(doc), source: step.symbol, file: step.file, line: step.line };
  }
  for (const step of flow.steps) {
    if (!["handler", "call"].includes(step.kind)) continue;
    const className = classOf(step.symbol);
    const doc = typeDoc(csharp, className);
    if (doc) return { text: firstSentences(doc), source: className, file: step.file, line: step.line };
  }
  return null;
}

function joinList(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function summarize(flow, story, repoName) {
  const parts = [];
  const trigger = story.triggeredBy;
  if (flow.trigger.kind === "queue") {
    parts.push(trigger.outsideRepo
      ? `Runs when ${trigger.ownerHint || "another service"} sends a "${flow.trigger.label}" message${trigger.ownerHint ? ", outside this repo" : ""}.`
      : `Runs when ${repoName} itself publishes a "${flow.trigger.label}" message.`);
  } else if (flow.trigger.kind === "cli") {
    parts.push(`Runs when someone executes the "${flow.trigger.label}" command.`);
  } else {
    parts.push(`Runs when a client calls ${flow.trigger.label}.`);
  }
  if (story.purpose) parts.push(story.purpose.text);
  for (const group of story.fanOut) {
    parts.push(`It runs ${group.members.length} checks: ${joinList(group.members.map((member) => member.label.toLowerCase()))}.`);
  }
  const systems = (access) => [...new Set(story.produces.boundaries
    .filter((item) => item.access === access).map((item) => item.system))];
  const effects = [];
  if (systems("write").length) effects.push(`writes to ${joinList(systems("write"))}`);
  if (systems("read").length) effects.push(`reads ${joinList(systems("read"))}`);
  if (systems("send").length) effects.push(`calls ${joinList(systems("send"))}`);
  if (effects.length) parts.push(`Along the way it ${joinList(effects)}.`);
  if (systems("check").length) parts.push(`Those checks touch ${joinList(systems("check"))}.`);
  if (story.produces.metrics.length) {
    parts.push(`You can watch it in Datadog as ${joinList(story.produces.metrics.map((metric) => metric.name))}.`);
  }
  return parts.join(" ");
}

function buildStories(flows, context) {
  const csharp = indexCsharp(context.sources);
  const usingsByFile = new Map();
  for (const entry of csharp.types.values()) usingsByFile.set(entry.file, entry.usings);
  for (const source of context.sources) {
    if (source.extension === ".cs" && !usingsByFile.has(source.file)) {
      usingsByFile.set(source.file, [...source.text.matchAll(/^\s*using\s+(?!static\b)([\w.]+)\s*;/gm)].map((match) => match[1]));
    }
  }
  const settings = loadSettings(context.configFiles || []);
  const storyContext = { csharp, functions: context.functions, usingsByFile };

  for (const flow of flows) {
    const repoName = selfName(csharp, flow.service);
    const trigger = triggeredBy(flow, storyContext);
    const groups = fanOut(flow, csharp);
    const story = {
      category: category(flow, trigger),
      purpose: purposeFor(flow, csharp),
      triggeredBy: trigger,
      fanOut: groups,
      produces: { metrics: metrics(flow, csharp), boundaries: boundaries(flow, groups) },
      timing: timing(flow, settings, groups),
    };
    story.summary = summarize(flow, story, repoName);
    for (const step of flow.steps) {
      const doc = ["handler", "call"].includes(step.kind) ? memberDoc(csharp, step.symbol) : "";
      if (doc) step.doc = firstSentences(doc, 1);
    }
    flow.story = story;
  }
  return flows;
}

module.exports = { buildStories, cleanDoc, humanDuration, indexCsharp };
