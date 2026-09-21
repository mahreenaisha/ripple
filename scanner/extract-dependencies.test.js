"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { extractDependencies } = require("./extract-dependencies");

function makeRepository(t) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "dependency-scanner-"));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  return repository;
}

function write(repository, relativePath, contents) {
  const filePath = path.join(repository, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function hasEdge(edges, from, to, type) {
  return edges.some(
    (edge) => edge.from === from && edge.to === to && edge.type === type,
  );
}

test("extracts imports, HTTP calls, databases, external APIs, and queues", (t) => {
  const repository = makeRepository(t);
  const services = [
    { name: "auth-service", path: "services/auth", language: "Node.js" },
    { name: "order-service", path: "services/orders", language: "Node.js" },
  ];

  write(repository, "services/auth/package.json", '{"name":"@company/auth"}');
  write(repository, "services/auth/index.js", "module.exports = {};\n");
  write(repository, "services/orders/package.json", '{"name":"order-service"}');
  write(
    repository,
    "services/orders/index.ts",
    [
      'import { verify } from "@company/auth";',
      'fetch("http://auth-service:3000/verify");',
      'const db = new MongoClient(process.env.DATABASE_URL);',
      'const stripe = new Stripe(process.env.STRIPE_KEY);',
      'const producer = new KafkaProducer();',
      '// https://documentation.example.com is not a runtime call',
      "",
    ].join("\n"),
  );

  const edges = extractDependencies(repository, services);
  assert.ok(hasEdge(edges, "order-service", "auth-service", "import"));
  assert.ok(hasEdge(edges, "order-service", "auth-service", "http_call"));
  assert.ok(hasEdge(edges, "order-service", "MongoDB", "database"));
  assert.ok(hasEdge(edges, "order-service", "Stripe", "external_api"));
  assert.ok(hasEdge(edges, "order-service", "Kafka", "message_queue"));
  assert.ok(!edges.some((edge) => edge.to === "documentation.example.com"));
});

test("follows C# project references and attributes shared code dependencies", (t) => {
  const repository = makeRepository(t);
  const services = [
    { name: "Device.Server", path: "server/Device.Server", language: "C#" },
    { name: "Device.Utility", path: "utilities/Device.Utility", language: "C#" },
  ];

  write(
    repository,
    "server/Device.Server/Device.Server.csproj",
    '<Project><ItemGroup><ProjectReference Include="..\\Core\\Core.csproj" /></ItemGroup></Project>',
  );
  write(repository, "server/Device.Server/Program.cs", "class Program {}\n");
  write(repository, "server/Core/Core.csproj", "<Project />");
  write(
    repository,
    "server/Core/Dependencies.cs",
    "IAmazonDynamoDB database;\nIAmazonSQS queue;\nIAmazonIoT iot;\n",
  );
  write(
    repository,
    "utilities/Device.Utility/Device.Utility.csproj",
    '<Project><ItemGroup><ProjectReference Include="..\\..\\server\\Core\\Core.csproj" /></ItemGroup></Project>',
  );
  write(repository, "utilities/Device.Utility/Program.cs", "class Program {}\n");

  const edges = extractDependencies(repository, services);
  assert.ok(hasEdge(edges, "Device.Utility", "Device.Server", "import"));
  assert.ok(hasEdge(edges, "Device.Server", "DynamoDB", "database"));
  assert.ok(hasEdge(edges, "Device.Server", "AWS SQS", "message_queue"));
  assert.ok(hasEdge(edges, "Device.Server", "AWS IoT", "external_api"));
  assert.ok(hasEdge(edges, "Device.Utility", "DynamoDB", "database"));
});

test("extracts configured service hosts and validates evidence locations", (t) => {
  const repository = makeRepository(t);
  const services = [
    { name: "api", path: "api", language: "Python" },
  ];
  write(
    repository,
    "api/appsettings.json",
    [
      "{",
      '  \"HostName\": \"authorizationas-service\",',
      '  \"Nodes\": [\"http://opensearch:9200\"],',
      '  \"ServiceUrl\": \"https://sqs.us-east-1.amazonaws.com\"',
      "}",
      "",
    ].join("\n"),
  );

  const edges = extractDependencies(repository, services);
  assert.ok(hasEdge(edges, "api", "authorizationas-service", "http_call"));
  assert.ok(hasEdge(edges, "api", "OpenSearch", "database"));
  assert.ok(hasEdge(edges, "api", "AWS SQS", "message_queue"));

  for (const edge of edges) {
    const match = edge.evidence.match(/^(.+):(\d+): /);
    assert.ok(match, edge.evidence);
    const filePath = path.join(repository, match[1]);
    assert.ok(fs.existsSync(filePath));
    const lineCount = fs.readFileSync(filePath, "utf8").split(/\r?\n/).length;
    assert.ok(Number(match[2]) <= lineCount);
  }
});

test("rejects service paths outside the repository", (t) => {
  const repository = makeRepository(t);
  assert.throws(
    () =>
      extractDependencies(repository, [
        { name: "escape", path: "../outside", language: "Node.js" },
      ]),
    /escapes repository/,
  );
});
