"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  mergeMetadata,
  metadataToYaml,
  parseMetadataYaml,
} = require("./metadata-yaml");

test("parses editable metadata with comments and lists", () => {
  const metadata = parseMetadataYaml(`
services:
  "auth-service":
    status: active # safe default
    is_spof: true
    gotchas:
      - "Deploy before orders"
      - "Times out above #1000 requests"
    owner: "Platform team"
deployment_order:
  - "auth-service"
known_issues:
  - "Backups run at 2am UTC"
`);

  assert.deepEqual(metadata, {
    services: {
      "auth-service": {
        status: "active",
        is_spof: true,
        gotchas: ["Deploy before orders", "Times out above #1000 requests"],
        owner: "Platform team",
      },
    },
    deployment_order: ["auth-service"],
    known_issues: ["Backups run at 2am UTC"],
  });
});

test("adds defaults for new services without replacing human edits", () => {
  const metadata = mergeMetadata(
    {
      services: {
        auth: {
          status: "under_maintenance",
          is_spof: true,
          owner: "Platform",
        },
      },
      deployment_order: ["auth"],
      known_issues: ["Known issue"],
    },
    [
      { name: "auth" },
      { name: "orders" },
    ],
  );

  assert.equal(metadata.services.auth.status, "under_maintenance");
  assert.equal(metadata.services.auth.is_spof, true);
  assert.deepEqual(metadata.services.orders, {
    status: "active",
    is_spof: false,
    gotchas: null,
    owner: null,
  });
  assert.deepEqual(metadata.deployment_order, ["auth"]);
});

test("round-trips generated YAML and preserves custom fields", () => {
  const original = {
    services: {
      api: {
        status: "active",
        is_spof: false,
        gotchas: null,
        owner: null,
        runbook: "docs/runbook.md",
      },
    },
    deployment_order: [],
    known_issues: [],
  };
  assert.deepEqual(parseMetadataYaml(metadataToYaml(original)), original);
});
