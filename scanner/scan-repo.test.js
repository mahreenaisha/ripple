"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { scanRepository } = require("./scan-repo");

test("one-command scan preserves metadata edits and feeds diagrams", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scan-repo-"));
  const repository = path.join(root, "repo");
  const output = path.join(root, "snapshot");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(path.join(repository, "api"), { recursive: true });
  fs.writeFileSync(
    path.join(repository, "api", "package.json"),
    '{"name":"api-service","dependencies":{"express":"1.0.0"}}',
  );
  fs.writeFileSync(
    path.join(repository, "api", "index.js"),
    'app.get("/health", health);\nfunction health() { return "ok"; }\n',
  );

  const firstScan = scanRepository(repository, output);
  const metadataPath = path.join(output, "metadata.yaml");
  assert.ok(fs.existsSync(metadataPath));
  assert.equal(firstScan.flows, 1);
  const requestFlows = JSON.parse(
    fs.readFileSync(path.join(output, "request-flows.json"), "utf8"),
  );
  assert.equal(requestFlows.schema_version, "1.0.0");
  assert.equal(requestFlows.flows[0].trigger.label, "GET /health");
  fs.writeFileSync(
    metadataPath,
    `services:
  "api-service":
    status: active
    is_spof: true
    gotchas:
      - "Deploy before consumers"
    owner: "Platform"
deployment_order:
  - "api-service"
known_issues: []
`,
  );

  scanRepository(repository, output);
  const graph = JSON.parse(
    fs.readFileSync(path.join(output, "graph.json"), "utf8"),
  );
  const service = graph.nodes.find((node) => node.id === "api-service");
  assert.equal(service.metadata.is_spof, true);
  assert.equal(service.metadata.owner, "Platform");
  assert.deepEqual(service.metadata.gotchas, ["Deploy before consumers"]);
  assert.equal(service.spof_source, "human");

  const metadata = fs.readFileSync(metadataPath, "utf8");
  assert.match(metadata, /Deploy before consumers/);
  assert.match(
    fs.readFileSync(path.join(output, "architecture.mmd"), "utf8"),
    /SPOF/,
  );
  assert.match(
    fs.readFileSync(path.join(output, "architecture.html"), "utf8"),
    /Deploy before consumers/,
  );
});
