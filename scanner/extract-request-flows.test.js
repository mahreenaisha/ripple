"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { extractRequestFlows } = require("./extract-request-flows");

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

test("honors depth and flow caps and ignores test/generated/vendor code", (t) => {
  const repo = fixture(t);
  repo.write(
    "app/App.cs",
    `class App {
public void Ok() { Next(); }
private void Next() { Last(); }
private void Last() {}
}
`,
  );
  repo.write("app/tests/Bad.cs", "class Bad { public void TestHandler() {} }\n");
  repo.write("app/generated/Bad.cs", "class Bad { public void Generated() {} }\n");
  repo.write("app/vendor/Bad.cs", "class Bad { public void Vendor() {} }\n");

  const result = extractRequestFlows(
    repo.repository,
    [service("app", "app", "C#")],
    {
      app: {
        entries: [{ type: "API", endpoint: "GET /ok", file: "app/App.cs", line: 1 }],
      },
    },
    { maxDepth: 2, maxFlows: 1 },
  );
  assert.equal(result.flows.length, 1);
  assert.equal(result.flows[0].trigger.label, "GET /ok");
  assert.equal(result.flows[0].steps.at(-1).kind, "inference-limit");
});

test("builds a plain-English story for a background heartbeat job", (t) => {
  const repo = fixture(t);
  repo.write(
    "server/Queue/JobQueueMessageTypeDiscriminator.cs",
    `namespace Acme.DeviceAS.Server.Queue;
class JobQueueMessageTypeDiscriminator {
  static System.Type Resolve(string name) => name switch {
    "TenancyDevicesHeartbeat" => typeof(TenancyDevicesHeartbeat),
  };
}
`,
  );
  repo.write(
    "server/Queue/Handlers/TenancyDevicesHeartbeatHandler.cs",
    `using Acme.DeviceAS.Core;
using Acme.Shared.Models.TenancyMessages;
namespace Acme.DeviceAS.Server.Queue.Handlers;
public class TenancyDevicesHeartbeatHandler(IMetricsPublisher _metricsPublisher, ITenancyBackgroundProvider _tenancyBackgroundProvider)
    : TenancyEventMessageHandlerBase<TenancyDevicesHeartbeat>
{
    private const string MetricName = "queue.tenancy_devices_heartbeat";
    protected override async Task<bool> HandleMessage(TenancyDevicesHeartbeat message)
    {
        await _tenancyBackgroundProvider.ValidateDevicesHealth(message.TenantID);
        _metricsPublisher.Histogram(MetricName, 1);
        return true;
    }
}
`,
  );
  repo.write(
    "server/Core/ITenancyBackgroundProvider.cs",
    `namespace Acme.DeviceAS.Core;
public interface ITenancyBackgroundProvider
{
    /// <summary>
    /// Validates the health of acquisition controllers for a tenant.
    /// </summary>
    Task ValidateDevicesHealth(string tenantId);
}
`,
  );
  repo.write(
    "server/Core/TenancyBackgroundProvider.cs",
    `using System.Collections.Generic;
namespace Acme.DeviceAS.Core;
public class TenancyBackgroundProvider(IEnumerable<IValidator> validators) : ITenancyBackgroundProvider
{
    /// <inheritdoc/>
    public async Task ValidateDevicesHealth(string tenantId)
    {
        foreach (var validator in validators) { await validator.Validate(tenantId); }
    }
}
`,
  );
  repo.write(
    "server/Core/Validators.cs",
    `using Acme.OpenSearch.Abstractions;
namespace Acme.DeviceAS.Core;
public interface IValidator { Task Validate(string tenantId); }
/// <summary>Enqueues error events for expired heartbeats.</summary>
public class HeartbeatValidator(IEntityProvider entityProvider) : IValidator
{
    public async Task Validate(string tenantId) { }
}
/// <summary>Renews certificates that are about to expire.</summary>
public class CertificateRenewalValidator : IValidator
{
    public async Task Validate(string tenantId) { }
}
`,
  );
  repo.write(
    "server/appsettings.json",
    `{
  "NotificationSettings": {
    "HeartbeatDelay": "00:02:00",
    "UnrelatedTimeout": "00:00:30"
  }
}
`,
  );

  const result = extractRequestFlows(repo.repository, [service("server", "server", "C#")]);
  const flow = result.flows.find((item) => item.trigger.label === "TenancyDevicesHeartbeat");
  assert.ok(flow, "heartbeat queue flow is extracted");
  const { story } = flow;

  assert.equal(flow.trigger.message_type, "TenancyDevicesHeartbeat");
  assert.equal(story.category, "background-job");
  assert.equal(story.purpose.text, "Validates the health of acquisition controllers for a tenant.");
  assert.deepEqual(
    {
      outsideRepo: story.triggeredBy.outsideRepo,
      ownerHint: story.triggeredBy.ownerHint,
      namespace: story.triggeredBy.namespace,
    },
    { outsideRepo: true, ownerHint: "TenancyAS", namespace: "Acme.Shared.Models.TenancyMessages" },
  );
  assert.deepEqual(
    story.fanOut[0].members.map((member) => [member.label, member.summary]),
    [
      ["Certificate renewal", "Renews certificates that are about to expire."],
      ["Heartbeat", "Enqueues error events for expired heartbeats."],
    ],
  );
  assert.deepEqual(story.produces.metrics.map((metric) => metric.name), ["queue.tenancy_devices_heartbeat"]);
  assert.deepEqual(
    story.produces.boundaries.map((item) => [item.system, item.access]),
    [["OpenSearch", "check"]],
  );
  assert.deepEqual(
    story.timing.map((item) => [item.key, item.human]),
    [["NotificationSettings:HeartbeatDelay", "2 minutes"]],
  );
  assert.match(story.summary, /^Runs when TenancyAS sends a "TenancyDevicesHeartbeat" message, outside this repo\./);
  assert.match(story.summary, /It runs 2 checks: certificate renewal and heartbeat\./);
  assert.match(story.summary, /Datadog as queue\.tenancy_devices_heartbeat/);
});

test("marks HTTP triggers as user requests and keeps in-repo messages inside the repo", (t) => {
  const repo = fixture(t);
  repo.write(
    "server/Discriminator.cs",
    `namespace Acme.DeviceAS.Server;
class Discriminator {
  static System.Type Resolve(string name) => name switch {
    "StatusUpdateRequestMessage" => typeof(StatusUpdateRequestMessage),
  };
}
`,
  );
  repo.write(
    "server/StatusUpdateRequestMessage.cs",
    "namespace Acme.DeviceAS.Server;\npublic class StatusUpdateRequestMessage { }\n",
  );
  repo.write(
    "server/StatusHandler.cs",
    `namespace Acme.DeviceAS.Server;
public class StatusHandler : MessageHandlerBase<StatusUpdateRequestMessage>
{
    public Task<bool> HandleMessage(StatusUpdateRequestMessage message) { return Task.FromResult(true); }
}
`,
  );
  repo.write(
    "server/StatusPublisher.cs",
    `namespace Acme.DeviceAS.Server;
public class StatusPublisher
{
    public void Publish() { var message = new StatusUpdateRequestMessage(); }
}
`,
  );
  repo.write(
    "server/HealthController.cs",
    "class HealthController { public int Get() { return 1; } }\n",
  );

  const result = extractRequestFlows(
    repo.repository,
    [service("server", "server", "C#")],
    {
      server: {
        entries: [
          {
            type: "API",
            endpoint: "GET /health",
            file: "server/HealthController.cs",
            line: 1,
          },
        ],
      },
    },
  );
  const queue = result.flows.find((flow) => flow.trigger.kind === "queue");
  const api = result.flows.find((flow) => flow.trigger.kind === "api");

  assert.equal(queue.story.category, "device-event");
  assert.equal(queue.story.triggeredBy.outsideRepo, false);
  assert.deepEqual(queue.story.triggeredBy.publishers.map((item) => item.symbol), ["StatusPublisher.Publish"]);
  assert.equal(api.story.category, "user-request");
  assert.equal(api.story.summary, "Runs when a client calls GET /health.");
});
