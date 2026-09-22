"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  SCHEMA_VERSION,
  extractRequestFlows,
} = require("./extract-request-flows");

function fixture(t) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "request-flows-"));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  return {
    repository,
    write(relativePath, contents) {
      const target = path.join(repository, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    },
  };
}

function service(name, servicePath, language) {
  return { name, path: servicePath, language, kind: "api-service" };
}

test("extracts deterministic Express and FastAPI request paths", (t) => {
  const repo = fixture(t);
  repo.write(
    "node/app.js",
    `app.get("/users", listUsers);
async function listUsers(req, res) { return loadUsers(); }
async function loadUsers() { return db.queryAsync("select * from users"); }
`,
  );
  repo.write(
    "python/app.py",
    `@app.post("/orders")
async def create_order(order):
    return save_order(order)

def save_order(order):
    return repository.insert(order)
`,
  );

  const services = [
    service("node", "node", "Node.js"),
    service("python", "python", "Python"),
  ];
  const first = extractRequestFlows(repo.repository, services);
  const second = extractRequestFlows(repo.repository, services);

  assert.deepEqual(first, second);
  assert.equal(first.schema_version, SCHEMA_VERSION);
  assert.deepEqual(
    first.flows.map((flow) => flow.trigger.label),
    ["GET /users", "POST /orders"],
  );
  assert.deepEqual(
    first.flows[0].steps.map((step) => step.kind),
    ["api-trigger", "handler", "call", "database"],
  );
  assert.ok(first.flows.flatMap((flow) => flow.steps).every((step) =>
    step.file && step.line > 0 && step.confidence && step.evidence.length));
});

test("binds ASP.NET controllers through interface injection", (t) => {
  const repo = fixture(t);
  repo.write(
    "server/Startup.cs",
    "services.AddScoped<IDeviceService, DeviceService>();\n",
  );
  repo.write(
    "server/DevicesController.cs",
    `class DevicesController {
private readonly IDeviceService _devices;
public DevicesController(IDeviceService devices) { _devices = devices; }
[HttpGet("{id}")]
public async Task Get(string id) { await _devices.Load(id); }
}
`,
  );
  repo.write(
    "server/DeviceService.cs",
    `class DeviceService {
public async Task Load(string id) { await _repository.FindAsync(id); }
}
`,
  );
  const entries = {
    server: {
      entries: [{
        type: "API",
        endpoint: "GET /api/devices/{id}",
        file: "server/DevicesController.cs",
        line: 4,
      }],
    },
  };

  const result = extractRequestFlows(
    repo.repository,
    [service("server", "server", "C#")],
    entries,
  );
  assert.equal(result.flows.length, 1);
  assert.deepEqual(
    result.flows[0].steps.map((step) => step.symbol),
    [
      "GET /api/devices/{id}",
      "DevicesController.Get",
      "DeviceService.Load",
      "_repository.FindAsync",
    ],
  );
  assert.equal(result.flows[0].steps.at(-1).kind, "database");
});

test("adds C# queue flows only with discriminator and handler evidence", (t) => {
  const repo = fixture(t);
  repo.write(
    "server/Queue/MessageDiscriminator.cs",
    `class MessageDiscriminator {
public Type Resolve(string name) => name switch {
"DeviceChanged" => typeof(DeviceChangedMessage),
_ => throw new Exception()
};
}
`,
  );
  repo.write(
    "server/Queue/DeviceChangedHandler.cs",
    `class DeviceChangedHandler : MessageHandler<DeviceChangedMessage> {
protected async Task HandleMessage(DeviceChangedMessage message) {
await Process(message);
}
private async Task Process(DeviceChangedMessage message) {
await _publisher.Publish(message);
}
}
`,
  );

  const result = extractRequestFlows(
    repo.repository,
    [service("server", "server", "C#")],
  );
  assert.equal(result.flows.length, 1);
  assert.equal(result.flows[0].trigger.kind, "queue");
  assert.deepEqual(
    result.flows[0].steps.map((step) => step.kind),
    ["queue-trigger", "handler", "call", "queue"],
  );
});

test("emits one flow per trigger, preserves branches, and scores useful primary paths", (t) => {
  const repo = fixture(t);
  repo.write(
    "server/Controller.cs",
    `class Controller {
private readonly IEntityProvider _entityProvider;
public async Task Get() {
GetParameter();
LoadEntities();
}
private void GetParameter() { ParseParameter(); }
private void ParseParameter() { AccessorHelper(); }
private void AccessorHelper() { LastHelper(); }
private void LastHelper() {}
private async Task LoadEntities() { await _entityProvider.Query<Entity>(); }
}
`,
  );
  const entries = {
    server: { entries: [{ type: "API", endpoint: "GET /entities", file: "server/Controller.cs", line: 3 }] },
  };

  const shallow = extractRequestFlows(
    repo.repository,
    [service("server", "server", "C#")],
    entries,
    { maxDepth: 3 },
  );
  const deeper = extractRequestFlows(
    repo.repository,
    [service("server", "server", "C#")],
    entries,
    { maxDepth: 5 },
  );
  assert.equal(shallow.flows.length, 1);
  assert.equal(shallow.flows[0].id, deeper.flows[0].id);
  assert.equal(shallow.flows[0].steps.at(-1).kind, "database");
  assert.match(shallow.flows[0].steps.at(-1).label, /OpenSearch/);
  assert.ok(shallow.flows[0].branches.length >= 1);
  assert.ok(shallow.flows[0].branches.some((branch) =>
    branch.some((step) => step.kind === "inference-limit")));
});

test("names boundaries only from matching receiver and source evidence", (t) => {
  const repo = fixture(t);
  repo.write(
    "server/BoundaryController.cs",
    `class BoundaryController {
private readonly IDBRepository _dbRepository;
private readonly IAmazonIotData _iotData;
private readonly IMqttPublisher _mqttPublisher;
private readonly INotificationClient _notificationClient;
private readonly IEventBridgeJobQueuePublisher _jobQueue;
private readonly IHttpClient _deviceClient;
public async Task Post() {
await _dbRepository.Load();
await _iotData.Publish();
await _mqttPublisher.Publish();
await _notificationClient.Send();
await _jobQueue.Publish("DeviceProvisionEvents");
await _deviceClient.GetAsync();
}
}
`,
  );
  const entries = {
    server: { entries: [{ type: "API", endpoint: "POST /boundary", file: "server/BoundaryController.cs", line: 8 }] },
  };
  const flow = extractRequestFlows(
    repo.repository,
    [service("server", "server", "C#")],
    entries,
  ).flows[0];
  const labels = [flow.steps, ...(flow.branches || [])]
    .map((branch) => branch.at(-1).label);

  assert.ok(labels.some((label) => /DynamoDB/.test(label)));
  assert.ok(labels.some((label) => /AWS IoT/.test(label)));
  assert.ok(labels.some((label) => /MQTT/.test(label)));
  assert.ok(labels.some((label) => /notification service/.test(label)));
  assert.ok(labels.some((label) => /EventBridge target "DeviceProvisionEvents"/.test(label)));
  assert.ok(labels.some((label) => /HTTP via _deviceClient\.GetAsync/.test(label)));
});

test("uses scanner entry evidence for Java, Ruby, and CLI handlers", (t) => {
  const repo = fixture(t);
  repo.write(
    "java/AppController.java",
    `class AppController {
@GetMapping("/items")
public void listItems() { repository.queryAsync(); }
}
`,
  );
  repo.write("ruby/app.rb", 'get "/reports" do\n  Report.all\nend\n');
  repo.write(
    "tool/cli.py",
    '@click.command("sync")\ndef sync():\n    publish()\n\ndef publish():\n    queue.publish()\n',
  );
  const entries = {
    java: { entries: [{ type: "API", endpoint: "GET /items", file: "java/AppController.java", line: 2 }] },
    ruby: { entries: [{ type: "API", endpoint: "GET /reports", file: "ruby/app.rb", line: 1 }] },
    tool: { entries: [{ type: "CLI", endpoint: "sync", file: "tool/cli.py", line: 1 }] },
  };

  const result = extractRequestFlows(
    repo.repository,
    [
      service("java", "java", "Java"),
      service("ruby", "ruby", "Ruby"),
      { ...service("tool", "tool", "Python"), kind: "cli" },
    ],
    entries,
  );
  assert.deepEqual(
    result.flows.map((flow) => [flow.trigger.kind, flow.trigger.label]),
    [["api", "GET /items"], ["api", "GET /reports"], ["cli", "sync"]],
  );
  assert.equal(result.flows[1].steps[1].symbol, "inline-route-handler");
  assert.equal(result.flows[2].steps[0].kind, "cli-trigger");
});

test("honors depth and flow caps and ignores test/generated/vendor code", (t) => {
  const repo = fixture(t);
  repo.write("app/app.js", 'app.get("/ok", ok);\nfunction ok() { next(); }\nfunction next() { last(); }\nfunction last() {}\n');
  repo.write("app/tests/bad.js", 'app.get("/test", testHandler);\nfunction testHandler() {}\n');
  repo.write("app/generated/bad.js", 'app.get("/generated", generated);\nfunction generated() {}\n');
  repo.write("app/vendor/bad.js", 'app.get("/vendor", vendor);\nfunction vendor() {}\n');

  const result = extractRequestFlows(
    repo.repository,
    [service("app", "app", "Node.js")],
    {},
    { maxDepth: 2, maxFlows: 1 },
  );
  assert.equal(result.flows.length, 1);
  assert.equal(result.flows[0].trigger.label, "GET /ok");
  assert.equal(result.flows[0].steps.at(-1).kind, "inference-limit");
});
