"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const { scanRepository, inferRepoName, parseArgs, slugify } = require("./scan-repo");

function csharpRepository(t, name = "Orders.Api") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-csharp-scan-"));
  const repository = path.join(root, "wcc-orders");
  const output = path.join(root, "snapshots", "orders");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repository, "src", name), { recursive: true });
  fs.writeFileSync(
    path.join(repository, "src", name, `${name}.csproj`),
    '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>',
  );
  fs.writeFileSync(
    path.join(repository, "src", name, "Program.cs"),
    "var app = WebApplication.Create();\n",
  );
  fs.writeFileSync(
    path.join(repository, "src", name, "OrdersController.cs"),
    `[Route("api/orders")]
public class OrdersController {
  private readonly IOrderRepository _repository;
  [HttpPost]
  public async Task Create() { await _repository.Save(); }
}
`,
  );
  return { repository, output };
}

test("parses focused scan arguments and repository names", () => {
  assert.equal(
    inferRepoName("/code/wcc-deviceas", [{ name: "Waters.DeviceAS.Server" }]),
    "DeviceAS",
  );
  assert.equal(slugify("Orders API"), "orders-api");
  assert.deepEqual(
    parseArgs(["node", "scan", "/repo", "--out", "snapshots/x", "--name", "X"]),
    { repoPath: "/repo", out: "snapshots/x", name: "X" },
  );
});

test("writes only request-flow and snapshot artifacts", (t) => {
  const { repository, output } = csharpRepository(t);
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "architecture.svg"), "stale");
  const run = (...args) =>
    execFileSync("git", ["-C", repository, ...args], { stdio: "ignore" });
  run("init", "-q", "-b", "main");
  run("-c", "user.email=r@x", "-c", "user.name=r", "add", ".");
  run("-c", "user.email=r@x", "-c", "user.name=r", "commit", "-qm", "init");

  const result = scanRepository(repository, output);
  const files = fs.readdirSync(output).sort();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(output, "snapshot.json"), "utf8"),
  );
  const artifact = JSON.parse(
    fs.readFileSync(path.join(output, "request-flows.json"), "utf8"),
  );

  assert.deepEqual(files, ["request-flows.json", "snapshot.json"]);
  assert.equal(result.services, 1);
  assert.equal(result.flows, 1);
  assert.equal(artifact.flows[0].trigger.label, "POST /api/orders");
  assert.match(manifest.source.commit, /^[0-9a-f]{40}$/);
  assert.equal(artifact.generator.source.commit, manifest.source.commit);
});

test("ignores repositories without executable C# projects", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-not-csharp-"));
  const output = path.join(root, "snapshot");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"web"}');

  const result = scanRepository(root, output);

  assert.equal(result.services, 0);
  assert.equal(result.flows, 0);
});
