"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { identifyServices } = require("./identify-services");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csharp-services-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    write(relativePath, contents) {
      const target = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    },
  };
}

test("identifies executable ASP.NET Core projects only", (t) => {
  const repo = fixture(t);
  repo.write(
    "src/Orders.Api/Orders.Api.csproj",
    '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>',
  );
  repo.write("src/Orders.Api/Program.cs", "var app = WebApplication.Create();");
  repo.write(
    "src/Orders.Core/Orders.Core.csproj",
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Library</OutputType></PropertyGroup></Project>',
  );
  repo.write("src/Orders.Core/Program.cs", "class NotAnEntryPoint {}");
  repo.write("frontend/package.json", '{"name":"not-a-csharp-service"}');

  const services = identifyServices(repo.root);

  assert.deepEqual(services, [
    {
      name: "Orders.Api",
      path: "src/Orders.Api",
      language: "C#",
      entry_file: "src/Orders.Api/Program.cs",
      kind: "api-service",
      confidence: "high",
      evidence: [
        "manifest: Orders.Api.csproj",
        "entrypoint: Program.cs",
        "project SDK: Microsoft.NET.Sdk.Web",
      ],
    },
  ]);
});

test("rejects a missing repository", () => {
  assert.throws(() => identifyServices("/does/not/exist"), /not a directory/);
});
