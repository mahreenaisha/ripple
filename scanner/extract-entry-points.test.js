"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { extractEntryPoints } = require("./extract-entry-points");

function makeRepository(t) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "entry-scanner-"));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  return repository;
}

function write(repository, relativePath, contents) {
  const filePath = path.join(repository, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function service(name, servicePath, language, kind = "api-service") {
  return { name, path: servicePath, language, kind };
}

function endpoints(result, type) {
  return result.entries
    .filter((entry) => entry.type === type)
    .map((entry) => entry.endpoint);
}

test("extracts API routes across supported web frameworks", (t) => {
  const repository = makeRepository(t);
  write(
    repository,
    "services/node/server.js",
    'router.get("/users", listUsers);\napp.post("/users", createUser);\n',
  );
  write(
    repository,
    "services/python/app.py",
    '@app.get("/orders")\ndef orders(): pass\n@app.route("/health", methods=["GET", "HEAD"])\ndef health(): pass\n',
  );
  write(
    repository,
    "services/go/main.go",
    'router.GET("/devices", getDevices)\nhttp.HandleFunc("/ready", ready)\n',
  );
  write(
    repository,
    "services/java/AppController.java",
    '@RequestMapping("/api")\nclass AppController {\n@PostMapping("/items")\npublic void create() {}\n}\n',
  );
  write(
    repository,
    "services/ruby/app.rb",
    'get "/reports" do\nend\npost "/reports" do\nend\n',
  );

  const result = extractEntryPoints(repository, [
    service("node", "services/node", "Node.js"),
    service("python", "services/python", "Python"),
    service("go", "services/go", "Go"),
    service("java", "services/java", "Java"),
    service("ruby", "services/ruby", "Ruby"),
  ]);

  assert.deepEqual(
    endpoints(result.node, "API"),
    ["GET /users", "POST /users"],
  );
  assert.deepEqual(
    endpoints(result.python, "API"),
    ["GET /orders", "GET /health", "HEAD /health"],
  );
  assert.deepEqual(
    endpoints(result.go, "API"),
    ["GET /devices", "ANY /ready"],
  );
  assert.deepEqual(endpoints(result.java, "API"), [
    "POST /api/items",
  ]);
  assert.deepEqual(endpoints(result.ruby, "API"), [
    "GET /reports",
    "POST /reports",
  ]);
});

test("extracts ASP.NET attributed, minimal, health, and OData routes", (t) => {
  const repository = makeRepository(t);
  write(
    repository,
    "server/Startup.cs",
    'services.AddWatersOData(provider, mvc, "odata/v{version}/tenancy/{tenantId}", model);\nendpoints.MapHealthChecks("/health");\n',
  );
  write(
    repository,
    "server/Controllers/AdminController.cs",
    '[Route("api/[controller]")]\nclass AdminController {\n[HttpGet("{id}")]\npublic ActionResult GetById(string id) => Ok();\n}\n',
  );
  write(
    repository,
    "server/Controllers/ThingsController.cs",
    'class ThingsController : ODataBaseController<ThingsController> {\npublic ActionResult Get() => Ok();\npublic ActionResult GetThing(string key) => Ok();\npublic ActionResult PostThing() => Ok();\n[HttpPost]\npublic ActionResult Rebuild(string key) => Ok();\n}\n',
  );
  write(
    repository,
    "server/Program.cs",
    'app.MapGet("/status", () => "ok");\n',
  );

  const result = extractEntryPoints(repository, [
    service("server", "server", "C#"),
  ]);
  assert.deepEqual(
    endpoints(result.server, "API"),
    [
      "GET /api/Admin/{id}",
      "GET /odata/v{version}/tenancy/{tenantId}/Things",
      "GET /odata/v{version}/tenancy/{tenantId}/Things({key})",
      "POST /odata/v{version}/tenancy/{tenantId}/Things",
      "POST /odata/v{version}/tenancy/{tenantId}/Things({key})/Rebuild",
      "GET /status",
      "GET /health",
    ],
  );
  assert.equal(
    result.server.entries.find((entry) => entry.endpoint === "GET /api/Admin/{id}")
      .line,
    3,
  );
});

test("extracts CLI commands and explicit library exports", (t) => {
  const repository = makeRepository(t);
  write(
    repository,
    "apps/tool/Program.cs",
    'var root = new RootCommand();\n',
  );
  write(
    repository,
    "apps/tool/CleanupCommand.cs",
    'const string COMMAND_NAME = "cleanup";\nclass CleanupCommand : UtilityCommand(COMMAND_NAME) {}\n',
  );
  write(
    repository,
    "packages/sdk/index.ts",
    "export function connect() {}\nexport const VERSION = '1';\n",
  );
  write(
    repository,
    "apps/python/cli.py",
    '@click.command("sync")\ndef sync(): pass\n',
  );

  const result = extractEntryPoints(repository, [
    service("dotnet-tool", "apps/tool", "C#", "cli"),
    service("sdk", "packages/sdk", "Node.js", "library"),
    service("python-tool", "apps/python", "Python", "cli"),
  ]);

  assert.deepEqual(
    endpoints(result["dotnet-tool"], "CLI"),
    ["cleanup", "dotnet-tool"],
  );
  assert.deepEqual(
    endpoints(result.sdk, "export"),
    ["connect", "VERSION"],
  );
  assert.deepEqual(
    endpoints(result["python-tool"], "CLI"),
    ["sync"],
  );
  assert.ok(
    Object.values(result)
      .flatMap((item) => item.entries)
      .every((entry) => Number.isInteger(entry.line) && entry.line > 0),
  );
});

test("includes internal callable symbols from non-library services", (t) => {
  const repository = makeRepository(t);
  write(
    repository,
    "service/helpers.ts",
    "function internalHelper() {}\nexport function publicHelper() {}\n",
  );
  write(
    repository,
    "service/helpers.py",
    "def _internal_helper(): pass\ndef public_helper(): pass\n",
  );
  write(
    repository,
    "service/Helpers.cs",
    "class Helpers {\ninternal void InternalHelper() {}\npublic void PublicHelper() {}\nprivate void PrivateHelper() {}\n}\n",
  );

  const result = extractEntryPoints(repository, [
    service("mixed", "service", "C#"),
  ]);
  assert.deepEqual(endpoints(result.mixed, "export"), [
    "Helpers.InternalHelper",
    "Helpers.PublicHelper",
    "Helpers.PrivateHelper",
    "_internal_helper",
    "public_helper",
    "internalHelper",
    "publicHelper",
  ]);
});

test("rejects service paths outside the repository", (t) => {
  const repository = makeRepository(t);
  assert.throws(
    () =>
      extractEntryPoints(repository, [
        service("escape", "../outside", "Node.js"),
      ]),
    /escapes repository/,
  );
});
