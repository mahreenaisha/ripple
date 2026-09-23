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

const SCANNABLE_EXTENSIONS = new Set([
  ".cs",
  ".csproj",
  ".env",
  ".go",
  ".gradle",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".kts",
  ".mjs",
  ".mod",
  ".properties",
  ".py",
  ".rb",
  ".ts",
  ".tsx",
  ".xml",
  ".yaml",
  ".yml",
]);

const DATABASE_PATTERNS = [
  ["OpenSearch", /\b(?:OpenSearch|Elasticsearch|IElasticClient|ElasticsearchClient)\b/i],
  ["DynamoDB", /\b(?:DynamoDB|IAmazonDynamoDB|DynamoDbClient)\b/i],
  ["PostgreSQL", /\b(?:postgres(?:ql)?|Npgsql|psycopg)\b/i],
  ["MySQL", /\b(?:mysql|MySqlConnection)\b/i],
  ["MongoDB", /\b(?:mongodb|MongoClient|mongoose)\b/i],
  ["Redis", /\b(?:redis|StackExchange\.Redis|ioredis)\b/i],
  ["SQLite", /\b(?:sqlite|Microsoft\.Data\.Sqlite)\b/i],
  ["SQL Server", /\b(?:SqlConnection|Microsoft\.Data\.SqlClient|mssql)\b/i],
  ["relational_database", /\b(?:SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/],
  ["ORM", /\b(?:DbContext|EntityFramework|SQLAlchemy|Sequelize|PrismaClient|ActiveRecord)\b/i],
];

const QUEUE_PATTERNS = [
  ["AWS SQS", /\b(?:IAmazonSQS|AmazonSQS|SQSQueue|\w*Sqs\w*Queue\w*|QueueListener|SendMessageAsync)\b/],
  ["AWS EventBridge", /\b(?:EventBridge|AddEventBridge|IEventBridge)\b/i],
  ["MQTT", /\b(?:MQTT|Mqtt|AmazonIotData)\b/],
  ["Kafka", /\b(?:Kafka|KafkaProducer|KafkaConsumer|kafkajs)\b/i],
  ["RabbitMQ", /\b(?:RabbitMQ|IModel|amqplib|pika)\b/i],
];

const EXTERNAL_PATTERNS = [
  ["AWS IoT", /\b(?:IAmazonIoT|AmazonIoTClient|AWSSDK\.IoT)\b/],
  ["AWS Greengrass", /\b(?:Greengrass|GreenGrass|IAmazonGreengrassV2)\b/i],
  ["Stripe", /\b(?:Stripe|stripe\.(?:charges|paymentIntents))\b/i],
  ["Twilio", /\b(?:Twilio|twilio\.messages)\b/i],
];

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

function scanFiles(directory) {
  const files = [];
  const queue = [directory];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of listDirectory(current)) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
        queue.push(absolutePath);
      } else if (
        entry.isFile() &&
        (SCANNABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) ||
          entry.name === "Gemfile" ||
          entry.name === "Dockerfile")
      ) {
        files.push(absolutePath);
      }
    }
  }
  return files;
}

function lineNumberAt(text, offset) {
  return text.slice(0, offset).split(/\r?\n/).length;
}

function evidence(rootPath, filePath, line, text) {
  const compact = text.trim().replace(/\s+/g, " ").slice(0, 220);
  return `${toPosix(path.relative(rootPath, filePath))}:${line}: ${compact}`;
}

function normalizeName(value) {
  return value
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/\.(?:service|server|api)$/i, "")
    .replace(/[^a-z0-9]/g, "");
}

function matchingService(moduleName, services, packageNames) {
  const normalizedModule = normalizeName(moduleName);
  for (const service of services) {
    const candidates = [
      service.name,
      service.path,
      path.basename(service.path),
      packageNames.get(service.name),
    ].filter(Boolean);
    if (
      candidates.some((candidate) => {
        const normalizedCandidate = normalizeName(candidate);
        return (
          normalizedModule === normalizedCandidate ||
          normalizedModule.includes(normalizedCandidate)
        );
      })
    ) {
      return service.name;
    }
  }
  return null;
}

function packageNamesForServices(rootPath, services) {
  const names = new Map();
  for (const service of services) {
    const packageJson = path.join(rootPath, service.path, "package.json");
    try {
      const manifest = JSON.parse(fs.readFileSync(packageJson, "utf8"));
      if (typeof manifest.name === "string") {
        names.set(service.name, manifest.name);
      }
    } catch {
      // Other ecosystems do not use package.json.
    }
  }
  return names;
}

function addDependency(dependencies, seen, from, to, type, proof) {
  if (!to || from === to) {
    return;
  }
  const key = `${from}\0${to}\0${type}\0${proof}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  dependencies.push({ from, to, type, evidence: proof });
}

function resolveProjectReferences(
  rootPath,
  service,
  services,
  dependencies,
  seenDependencies,
) {
  const initialDirectory = path.resolve(rootPath, service.path);
  const queue = scanFiles(initialDirectory).filter((file) => file.endsWith(".csproj"));
  const visitedProjects = new Set();
  const directories = new Set([initialDirectory]);

  while (queue.length > 0) {
    const projectPath = queue.shift();
    if (visitedProjects.has(projectPath)) {
      continue;
    }
    visitedProjects.add(projectPath);
    directories.add(path.dirname(projectPath));
    const text = readText(projectPath);
    const pattern = /<ProjectReference\s+Include=["']([^"']+)["']/gi;
    for (const match of text.matchAll(pattern)) {
      const referencedPath = path.resolve(
        path.dirname(projectPath),
        match[1].replaceAll("\\", path.sep),
      );
      if (!referencedPath.startsWith(`${rootPath}${path.sep}`)) {
        continue;
      }
      const targetService = services.find((candidate) => {
        const serviceDirectory = path.resolve(rootPath, candidate.path);
        return (
          referencedPath === serviceDirectory ||
          referencedPath.startsWith(`${serviceDirectory}${path.sep}`)
        );
      }) || services.find((candidate) => {
        const targetRoot = path.relative(rootPath, referencedPath).split(path.sep)[0];
        const candidateRoot = candidate.path.split(/[\\/]/)[0];
        return (
          targetRoot === candidateRoot &&
          !["apps", "packages", "services"].includes(targetRoot)
        );
      });
      const target =
        targetService?.name ||
        `internal:${path.basename(referencedPath, path.extname(referencedPath))}`;
      addDependency(
        dependencies,
        seenDependencies,
        service.name,
        target,
        "import",
        evidence(
          rootPath,
          projectPath,
          lineNumberAt(text, match.index),
          match[0],
        ),
      );
      if (!targetService || targetService.name === service.name) {
        queue.push(referencedPath);
      }
    }
  }
  return directories;
}

function targetFromHostname(hostname, services) {
  const lower = hostname.toLowerCase();
  const service = services.find((candidate) => {
    const names = [candidate.name, path.basename(candidate.path)].map((name) =>
      name.toLowerCase().replace(/[^a-z0-9]/g, ""),
    );
    const host = lower.replace(/[^a-z0-9]/g, "");
    return names.some((name) => host.includes(name));
  });
  return service?.name || lower;
}

function scanTextFile(
  rootPath,
  service,
  services,
  packageNames,
  filePath,
  dependencies,
  seen,
) {
  const text = readText(filePath);
  const lines = text.split(/\r?\n/);
  const extension = path.extname(filePath).toLowerCase();

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (
      !trimmed ||
      /^(?:\/\/\/?|#|\*|<!--)/.test(trimmed) ||
      /["']?\$schema["']?\s*:/.test(trimmed)
    ) {
      return;
    }
    const proof = evidence(rootPath, filePath, index + 1, trimmed);

    const importPatterns = [];
    if ([".js", ".jsx", ".mjs", ".ts", ".tsx"].includes(extension)) {
      importPatterns.push(
        /\bfrom\s+["']([^"']+)["']/g,
        /\brequire\(\s*["']([^"']+)["']\s*\)/g,
      );
    } else if (extension === ".py") {
      importPatterns.push(/^\s*(?:from|import)\s+([A-Za-z0-9_.-]+)/g);
    } else if (extension === ".go") {
      importPatterns.push(/^\s*(?:import\s+)?["']([^"']+)["']/g);
    }
    for (const pattern of importPatterns) {
      for (const match of line.matchAll(pattern)) {
        const target = matchingService(match[1], services, packageNames);
        if (target) {
          addDependency(
            dependencies,
            seen,
            service.name,
            target,
            "import",
            proof,
          );
        }
      }
    }

    for (const urlMatch of line.matchAll(/https?:\/\/([A-Za-z0-9.-]+)(?::(\d+))?[^\s"'<>]*/g)) {
      const hostname = urlMatch[1].toLowerCase();
      const port = urlMatch[2];
      if (
        (hostname === "localhost" && port === "9200") ||
        hostname.includes("opensearch")
      ) {
        addDependency(dependencies, seen, service.name, "OpenSearch", "database", proof);
      } else if (hostname.includes("sqs.") && hostname.includes("amazonaws.com")) {
        addDependency(dependencies, seen, service.name, "AWS SQS", "message_queue", proof);
      } else if (!["localhost", "127.0.0.1"].includes(hostname)) {
        const target = targetFromHostname(hostname, services);
        const type =
          matchingService(hostname, services, packageNames) ||
          /(?:^|[.-])[\w-]+-service(?:[.:]|$)/.test(hostname)
            ? "http_call"
            : "external_api";
        addDependency(dependencies, seen, service.name, target, type, proof);
      }
    }

    const configuredHost = line.match(
      /["']?(?:HostName|BaseUrl|BaseURL|ServiceUrl|EndpointUrl)["']?\s*[:=]\s*["']([^"']+)["']/i,
    );
    if (configuredHost) {
      const rawTarget = configuredHost[1];
      if (!/^https?:\/\//i.test(rawTarget)) {
        const target = targetFromHostname(rawTarget, services);
        addDependency(
          dependencies,
          seen,
          service.name,
          target,
          "http_call",
          proof,
        );
      }
    }

    for (const [database, pattern] of DATABASE_PATTERNS) {
      if (pattern.test(line)) {
        addDependency(dependencies, seen, service.name, database, "database", proof);
      }
    }
    for (const [queue, pattern] of QUEUE_PATTERNS) {
      if (pattern.test(line)) {
        addDependency(dependencies, seen, service.name, queue, "message_queue", proof);
      }
    }
    for (const [external, pattern] of EXTERNAL_PATTERNS) {
      if (pattern.test(line)) {
        addDependency(dependencies, seen, service.name, external, "external_api", proof);
      }
    }

  });
}

function extractDependencies(repoPath, services) {
  const rootPath = path.resolve(repoPath);
  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
    throw new Error(`Repository path is not a directory: ${repoPath}`);
  }
  if (!Array.isArray(services)) {
    throw new TypeError("services must be an array");
  }

  const dependencies = [];
  const seen = new Set();
  const packageNames = packageNamesForServices(rootPath, services);

  for (const service of services) {
    const serviceDirectory = path.resolve(rootPath, service.path);
    if (
      serviceDirectory !== rootPath &&
      !serviceDirectory.startsWith(`${rootPath}${path.sep}`)
    ) {
      throw new Error(`Service path escapes repository: ${service.path}`);
    }

    const directories = resolveProjectReferences(
      rootPath,
      service,
      services,
      dependencies,
      seen,
    );
    const files = new Set();
    for (const directory of directories) {
      for (const file of scanFiles(directory)) {
        files.add(file);
      }
    }
    for (const file of [...files].sort()) {
      scanTextFile(
        rootPath,
        service,
        services,
        packageNames,
        file,
        dependencies,
        seen,
      );
    }
  }

  return dependencies.sort(
    (left, right) =>
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to) ||
      left.type.localeCompare(right.type) ||
      left.evidence.localeCompare(right.evidence),
  );
}

function runCli(argv) {
  if (!argv[2] || !argv[3]) {
    console.error(
      "Usage: node scanner/extract-dependencies.js <repo-path> <services-json> [output-file]",
    );
    process.exitCode = 1;
    return;
  }

  try {
    const services = JSON.parse(fs.readFileSync(path.resolve(argv[3]), "utf8"));
    const outputPath = path.resolve(argv[4] || "dependencies.json");
    const result = extractDependencies(argv[2], services);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Identified ${result.length} dependency evidence item(s); wrote ${outputPath}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runCli(process.argv);
}

module.exports = { extractDependencies };
