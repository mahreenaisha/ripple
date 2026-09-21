"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { identifyServices } = require("./identify-services");

function makeRepository(t) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "service-scanner-"));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  return repository;
}

function write(repository, relativePath, contents = "") {
  const filePath = path.join(repository, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

test("identifies executable services in all supported languages", (t) => {
  const repository = makeRepository(t);

  write(
    repository,
    "services/auth/package.json",
    JSON.stringify({
      name: "@acme/auth-service",
      scripts: { start: "node src/server.js" },
    }),
  );
  write(repository, "services/auth/src/server.js");

  write(repository, "apps/payments/requirements.txt", "fastapi\n");
  write(repository, "apps/payments/app.py");

  write(repository, "packages/orders/go.mod", "module example.com/orders\n");
  write(repository, "packages/orders/cmd/api/main.go", "package main\n");

  write(repository, "catalog/pom.xml", "<project />");
  write(
    repository,
    "catalog/src/main/java/com/acme/CatalogApplication.java",
    "class CatalogApplication { public static void main(String[] args) {} }",
  );

  write(repository, "services/reporting/Gemfile", 'source "https://rubygems.org"\n');
  write(repository, "services/reporting/config.ru", "run App\n");

  write(
    repository,
    "architecture.sln",
    'Project("{GUID}") = "Billing", "src\\Billing\\Billing.csproj", "{GUID}"\n',
  );
  write(
    repository,
    "src/Billing/Billing.csproj",
    '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>',
  );
  write(repository, "src/Billing/Program.cs", "var app = WebApplication.CreateBuilder(args);\n");

  assert.deepEqual(identifyServices(repository), [
    {
      name: "payments",
      path: "apps/payments",
      language: "Python",
      entry_file: "apps/payments/app.py",
      kind: "api-service",
      confidence: "high",
      evidence: [
        "manifest: requirements.txt",
        "entrypoint: app.py",
        "framework: Python web framework",
      ],
    },
    {
      name: "catalog",
      path: "catalog",
      language: "Java",
      entry_file: "catalog/src/main/java/com/acme/CatalogApplication.java",
      kind: "application",
      confidence: "medium",
      evidence: [
        "manifest: pom.xml",
        "entrypoint: src/main/java/com/acme/CatalogApplication.java",
      ],
    },
    {
      name: "orders",
      path: "packages/orders",
      language: "Go",
      entry_file: "packages/orders/cmd/api/main.go",
      kind: "application",
      confidence: "medium",
      evidence: ["manifest: go.mod", "entrypoint: cmd/api/main.go"],
    },
    {
      name: "auth-service",
      path: "services/auth",
      language: "Node.js",
      entry_file: "services/auth/src/server.js",
      kind: "application",
      confidence: "medium",
      evidence: ["manifest: package.json", "entrypoint: src/server.js"],
    },
    {
      name: "reporting",
      path: "services/reporting",
      language: "Ruby",
      entry_file: "services/reporting/config.ru",
      kind: "api-service",
      confidence: "high",
      evidence: [
        "manifest: Gemfile",
        "entrypoint: config.ru",
        "framework: Rack",
      ],
    },
    {
      name: "Billing",
      path: "src/Billing",
      language: "C#",
      entry_file: "src/Billing/Program.cs",
      kind: "api-service",
      confidence: "high",
      evidence: [
        "manifest: Billing.csproj",
        "entrypoint: Program.cs",
        "project SDK: Microsoft.NET.Sdk.Web",
      ],
    },
  ]);
});

test("excludes dependencies, tests, and projects without executable evidence", (t) => {
  const repository = makeRepository(t);

  write(repository, "packages/library/package.json", '{"name":"library"}');
  write(
    repository,
    "apps/shared/Shared.csproj",
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Library</OutputType></PropertyGroup></Project>',
  );
  write(repository, "apps/shared/Program.cs");
  write(repository, "services/python-lib/requirements.txt");
  write(repository, "services/python-lib/__init__.py");

  write(repository, "node_modules/fake/package.json", '{"main":"index.js"}');
  write(repository, "node_modules/fake/index.js");
  write(repository, "vendor/fake/go.mod");
  write(repository, "vendor/fake/main.go");
  write(repository, "tests/fake/Gemfile");
  write(repository, "tests/fake/app.rb");

  assert.deepEqual(identifyServices(repository), []);
});

test("uses declared entry points first and returns stable path ordering", (t) => {
  const repository = makeRepository(t);

  write(
    repository,
    "services/zeta/package.json",
    JSON.stringify({ name: "zeta-api", main: "dist/missing.js", scripts: { start: "tsx src/api.ts" } }),
  );
  write(repository, "services/zeta/src/api.ts");
  write(repository, "services/zeta/index.js");
  write(
    repository,
    "services/zeta/internal/helper/package.json",
    JSON.stringify({ name: "implementation-detail", main: "index.js" }),
  );
  write(repository, "services/zeta/internal/helper/index.js");

  write(repository, "apps/alpha/pyproject.toml", "[project]\nname = 'alpha'\n");
  write(repository, "apps/alpha/main.py");

  const first = identifyServices(repository);
  const second = identifyServices(repository);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map((service) => service.path),
    ["apps/alpha", "services/zeta"],
  );
  assert.equal(first[1].entry_file, "services/zeta/src/api.ts");
});

test("classifies C# CLIs, jobs, and deployment init containers", (t) => {
  const repository = makeRepository(t);

  write(
    repository,
    "apps/migrator/Migrator.csproj",
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup><ItemGroup><PackageReference Include="System.CommandLine" /></ItemGroup></Project>',
  );
  write(repository, "apps/migrator/Program.cs");

  write(
    repository,
    "apps/cleanup/Cleanup.csproj",
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup></Project>',
  );
  write(repository, "apps/cleanup/Program.cs");
  write(repository, "apps/cleanup/README.md", "Runs in the EKS cluster as a Kubernetes job.\n");

  write(
    repository,
    "apps/schema/Schema.csproj",
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup></Project>',
  );
  write(repository, "apps/schema/Program.cs");
  write(
    repository,
    "infrastructure/application.tf",
    'init_containers = [\n  {\n    command = ["dotnet"]\n    args = ["/app/Schema.dll"]\n  }\n]\n',
  );

  const services = identifyServices(repository);
  assert.deepEqual(
    Object.fromEntries(
      services.map((service) => [
        service.name,
        { kind: service.kind, confidence: service.confidence },
      ]),
    ),
    {
      Cleanup: { kind: "job", confidence: "high" },
      Migrator: { kind: "cli", confidence: "high" },
      Schema: { kind: "init-container", confidence: "high" },
    },
  );
});

test("CLI writes formatted JSON to the requested output file", (t) => {
  const repository = makeRepository(t);
  const outputPath = path.join(repository, "review", "services.json");

  write(repository, "backend/requirements.txt", "fastapi\n");
  write(repository, "backend/main.py");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "identify-services.js"), repository, outputPath],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Identified 1 service/);
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf8")), [
    {
      name: "backend",
      path: "backend",
      language: "Python",
      entry_file: "backend/main.py",
      kind: "api-service",
      confidence: "high",
      evidence: [
        "manifest: requirements.txt",
        "entrypoint: main.py",
        "framework: Python web framework",
      ],
    },
  ]);
});
