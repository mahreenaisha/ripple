"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  canAccess,
  createAccessCatalog,
  getServiceRepos,
  getUserAccess,
  getUserServices,
  getUsersForService,
} = require("./index");

test("queries the checked-in access catalog", () => {
  assert.deepEqual(getUserServices("alice"), ["backend", "ripple-frontend"]);
  assert.deepEqual(getServiceRepos("backend"), [
    "https://github.com/mahreenaisha/ripple",
  ]);
  assert.deepEqual(getUserAccess("alice"), {
    repos: ["https://github.com/mahreenaisha/ripple"],
    spaces: [],
    databases: [],
    services: [],
  });
  assert.equal(canAccess("bob", "backend"), false);
  assert.equal(canAccess("missing", "backend"), false);
  assert.deepEqual(getUsersForService("ripple-frontend"), ["alice", "bob"]);
});

test("loads alternate YAML files and aggregates access without duplicates", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "access-catalog-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const usersPath = path.join(directory, "users.yaml");
  const servicesPath = path.join(directory, "services.yaml");

  fs.writeFileSync(
    usersPath,
    `schema_version: 1
users:
  - id: alice
    name: Alice
    team: Platform
    role: Engineer
    access_level: read-only
    services:
      - service_id: auth
        role: occasional
`,
  );
  fs.writeFileSync(
    servicesPath,
    `schema_version: 1
services:
  - id: auth
    name: Authentication
    repos:
      - https://example.com/auth.git
    confluence:
      - AUTH
    databases:
      - identity
    external_services:
      - okta
    deployment:
      environment: production
      region: us-east-1
`,
  );

  const catalog = createAccessCatalog({ usersPath, servicesPath });
  assert.deepEqual(catalog.getUserAccess("alice"), {
    repos: ["https://example.com/auth.git"],
    spaces: ["AUTH"],
    databases: ["identity"],
    services: ["okta"],
  });
  assert.equal(catalog.canAccess("alice", "auth"), true);
});

test("rejects assignments to unknown services", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "access-catalog-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const usersPath = path.join(directory, "users.yaml");
  const servicesPath = path.join(directory, "services.yaml");

  fs.writeFileSync(
    usersPath,
    `schema_version: 1
users:
  - id: alice
    name: Alice
    team: Platform
    role: Engineer
    access_level: standard
    services:
      - service_id: missing
        role: core
`,
  );
  fs.writeFileSync(servicesPath, "schema_version: 1\nservices: []\n");

  assert.throws(
    () => createAccessCatalog({ usersPath, servicesPath }),
    /service_id is unknown: missing/,
  );
});
