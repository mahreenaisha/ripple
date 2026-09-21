"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { buildDependencyGraph } = require("./build-dependency-graph");

function makeRepository(t) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "graph-builder-"));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  return repository;
}

function write(repository, relativePath, contents) {
  const filePath = path.join(repository, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

test("builds weighted nodes and edges while filtering one-off service calls", (t) => {
  const repository = makeRepository(t);
  write(repository, "services/a/index.ts", "const one = 1;\n\nconst two = 2;\n");
  write(repository, "services/b/main.py", "print('ready')\n");

  const services = [
    { name: "service-a", path: "services/a", language: "Node.js" },
    { name: "service-b", path: "services/b", language: "Python" },
  ];
  const entryPoints = {
    "service-a": {
      entries: [
        { type: "API", endpoint: "GET /a" },
        { type: "CLI", endpoint: "sync" },
        { type: "export", endpoint: "helper" },
      ],
    },
    "service-b": { entries: [] },
  };
  const dependencies = [
    { from: "service-a", to: "service-b", type: "http_call", evidence: "a:1" },
    { from: "service-a", to: "service-b", type: "http_call", evidence: "a:6" },
    { from: "service-a", to: "service-b", type: "import", evidence: "a:2" },
    { from: "service-b", to: "service-a", type: "http_call", evidence: "b:1" },
    { from: "service-a", to: "PostgreSQL", type: "database", evidence: "a:3" },
    { from: "service-a", to: "Stripe", type: "external_api", evidence: "a:4" },
    {
      from: "service-a",
      to: "AWS SQS",
      type: "message_queue",
      evidence: "publisher.SendMessageAsync",
    },
    {
      from: "service-a",
      to: "AWS SQS",
      type: "message_queue",
      evidence: "queue listener receives messages",
    },
    {
      from: "service-a",
      to: "internal:shared",
      type: "import",
      evidence: "a:5",
    },
  ];

  const graph = buildDependencyGraph(
    repository,
    services,
    entryPoints,
    dependencies,
    {
      repoUrl: "https://example.test/repository.git",
      metadata: {
        services: {
          "service-a": {
            status: "under_maintenance",
            is_spof: true,
            gotchas: ["Deploy first"],
            owner: "Platform",
          },
        },
        deployment_order: ["service-a", "service-b"],
        known_issues: ["Maintenance window"],
      },
    },
  );

  assert.deepEqual(graph.edges, [
    {
      from: "service-a",
      to: "AWS SQS",
      type: "publishes",
      count: 1,
      confidence: "high",
    },
    {
      from: "service-a",
      to: "AWS SQS",
      type: "subscribes",
      count: 1,
      confidence: "high",
    },
    {
      from: "service-a",
      to: "PostgreSQL",
      type: "queries",
      count: 1,
      confidence: "medium",
    },
    {
      from: "service-a",
      to: "service-b",
      type: "calls",
      count: 2,
      confidence: "high",
    },
    {
      from: "service-a",
      to: "service-b",
      type: "imports",
      count: 1,
      confidence: "high",
    },
    {
      from: "service-a",
      to: "Stripe",
      type: "calls",
      count: 1,
      confidence: "medium",
    },
  ]);

  const serviceA = graph.nodes.find((node) => node.id === "service-a");
  const serviceB = graph.nodes.find((node) => node.id === "service-b");
  const database = graph.nodes.find((node) => node.id === "PostgreSQL");
  assert.equal(serviceA.entry_points_count, 2);
  assert.equal(serviceA.metadata.lines_of_code, 2);
  assert.equal(serviceA.metadata.status, "under_maintenance");
  assert.equal(serviceA.metadata.owner, "Platform");
  assert.equal(serviceA.spof_candidate, true);
  assert.equal(serviceA.spof_source, "human");
  assert.deepEqual(serviceA.databases, ["PostgreSQL"]);
  assert.deepEqual(serviceB.dependents, ["service-a"]);
  assert.equal(database.type, "database");
  assert.equal(graph.nodes.find((node) => node.id === "AWS SQS").type, "external_api");
  assert.ok(!graph.edges.some((edge) => edge.from === "service-b"));
  assert.ok(!graph.nodes.some((node) => node.id === "internal:shared"));
  assert.equal(graph.metadata.repo_url, "https://example.test/repository.git");
  assert.equal(graph.metadata.total_services, 2);
  assert.deepEqual(graph.metadata.deployment_order, [
    "service-a",
    "service-b",
  ]);
  assert.deepEqual(graph.metadata.known_issues, ["Maintenance window"]);
  assert.match(graph.metadata.generated_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("reads service last-modified metadata from git", (t) => {
  const repository = makeRepository(t);
  write(repository, "app/main.go", "package main\n\nfunc main() {}\n");

  for (const args of [
    ["init"],
    ["config", "user.email", "scanner@example.test"],
    ["config", "user.name", "Scanner Test"],
    ["add", "app/main.go"],
    ["commit", "-m", "initial"],
  ]) {
    const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }

  const graph = buildDependencyGraph(
    repository,
    [{ name: "app", path: "app", language: "Go" }],
    { app: { entries: [] } },
    [],
  );
  assert.match(
    graph.nodes.find((node) => node.id === "app").metadata.last_modified,
    /^\d{4}-\d{2}-\d{2}T/,
  );
});

test("groups environment hosts and flags shared runtime dependencies", (t) => {
  const repository = makeRepository(t);
  write(repository, "a/main.js", "console.log('a');\n");
  write(repository, "b/main.js", "console.log('b');\n");

  const graph = buildDependencyGraph(
    repository,
    [
      { name: "a", path: "a", language: "Node.js" },
      { name: "b", path: "b", language: "Node.js" },
    ],
    { a: { entries: [] }, b: { entries: [] } },
    [
      {
        from: "a",
        to: "cognito-idp.us-east-1.amazonaws.com",
        type: "external_api",
        evidence: "a/main.js:1: cognito",
      },
      {
        from: "b",
        to: "tenant.auth.us-east-1.amazoncognito.com",
        type: "external_api",
        evidence: "b/main.js:1: cognito",
      },
    ],
  );

  const cognito = graph.nodes.find((node) => node.id === "AWS Cognito");
  assert.deepEqual(cognito.dependents, ["a", "b"]);
  assert.equal(cognito.spof_candidate, true);
  assert.ok(
    !graph.nodes.some((node) => node.id.includes("amazoncognito.com")),
  );
});

test("rejects service paths outside the repository", (t) => {
  const repository = makeRepository(t);
  assert.throws(
    () =>
      buildDependencyGraph(
        repository,
        [{ name: "escape", path: "../outside", language: "Ruby" }],
        { escape: { entries: [] } },
        [],
      ),
    /escapes repository/,
  );
});
