"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { extractEntryPoints } = require("./extract-entry-points");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aspnet-entries-"));
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

function service() {
  return {
    name: "Orders.Api",
    path: "src/Orders.Api",
    language: "C#",
    kind: "api-service",
  };
}

test("extracts ASP.NET controller and minimal API routes", (t) => {
  const repo = fixture(t);
  repo.write(
    "src/Orders.Api/OrdersController.cs",
    `[Route("api/[controller]")]
public class OrdersController {
  [HttpGet("{id}")]
  public async Task Get(string id) => await Load(id);

  [HttpPost]
  public async Task Post() => await Save();
}
`,
  );
  repo.write(
    "src/Orders.Api/Program.cs",
    'app.MapDelete("/health/{id}", DeleteHealth);\n',
  );

  const result = extractEntryPoints(repo.root, [service()]);
  assert.deepEqual(
    result["Orders.Api"].entries.map((entry) => entry.endpoint),
    ["GET /api/Orders/{id}", "POST /api/Orders", "DELETE /health/{id}"],
  );
});

test("extracts OData convention routes", (t) => {
  const repo = fixture(t);
  repo.write(
    "src/Orders.Api/Startup.cs",
    'services.AddOData("odata/v{version}");',
  );
  repo.write(
    "src/Orders.Api/OrdersController.cs",
    `public class OrdersController : ODataController {
  [HttpGet]
  public async Task Get() => await Load();
}
`,
  );

  const result = extractEntryPoints(repo.root, [service()]);
  assert.equal(
    result["Orders.Api"].entries[0].endpoint,
    "GET /odata/v{version}/Orders",
  );
});

test("ignores non-C# services and rejects traversal", (t) => {
  const repo = fixture(t);
  assert.deepEqual(
    extractEntryPoints(repo.root, [
      { name: "frontend", path: ".", language: "TypeScript" },
    ]),
    {},
  );
  assert.throws(
    () =>
      extractEntryPoints(repo.root, [
        { name: "escape", path: "../outside", language: "C#" },
      ]),
    /escapes repository/,
  );
});
