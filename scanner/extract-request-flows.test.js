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
  const result = {
    repository,
    write(relativePath, contents) {
      const target = path.join(repository, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    },
  };
  for (const directory of ["server"]) {
    result.write(
      `${directory}/${directory}.csproj`,
      `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
`,
    );
    result.write(`${directory}/Program.cs`, "public static class Program { public static void Main() {} }\n");
    result.write(
      `${directory}/AspNetStubs.cs`,
      `public sealed class RouteAttribute(string template) : Attribute { }
public sealed class HttpGetAttribute : Attribute {
  public HttpGetAttribute() { }
  public HttpGetAttribute(string template) { }
}
public sealed class HttpPostAttribute : Attribute {
  public HttpPostAttribute() { }
  public HttpPostAttribute(string template) { }
}
`,
    );
  }
  return result;
}

function service(name, servicePath, language) {
  return { name, path: servicePath, language, kind: "api-service" };
}

function mapEdge(graph) {
  const labels = new Map(graph.nodes.map((node) => [node.id, node.label]));
  return (source, kind, target) => graph.edges.find((edge) =>
    labels.get(edge.source) === source
    && edge.kind === kind
    && labels.get(edge.target) === target);
}

test("binds ASP.NET controllers through interface injection", (t) => {
  const repo = fixture(t);
  repo.write(
    "server/Startup.cs",
    `interface IServiceCollection { }
static class ServiceCollectionExtensions {
  public static void AddScoped<TContract, TImplementation>(this IServiceCollection services) { }
}
class Startup {
  void Configure(IServiceCollection services) {
    services.AddScoped<IDeviceService, DeviceService>();
  }
}
`,
  );
  repo.write(
    "server/DevicesController.cs",
    `[Route("api/devices")]
class DevicesController {
private readonly IDeviceService _devices;
public DevicesController(IDeviceService devices) { _devices = devices; }
[HttpGet("{id}")]
public async Task Get(string id) { await _devices.Load(id); }
}
`,
  );
  repo.write(
    "server/DeviceService.cs",
    `interface IDeviceService { Task Load(string id); }
interface IDeviceRepository { Task FindAsync(string id); }
class DeviceService : IDeviceService {
private readonly IDeviceRepository _repository;
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
      "IDeviceRepository.FindAsync",
    ],
  );
  assert.equal(result.flows[0].steps.at(-1).kind, "database");
  const graph = result.architecture_graph;
  assert.equal(graph.schema_version, "2.0.0");
  assert.deepEqual(
    graph.nodes.map((node) => [node.kind, node.label]),
    [["service", "server"], ["entrypoint", "GET /api/devices/{id}"]],
  );
  const handles = graph.edges.find((edge) => edge.kind === "handles");
  assert.equal(handles.evidence[0].kind, "route");
  assert.deepEqual(handles.flow_ids, [result.flows[0].id]);
  const repeated = extractRequestFlows(
    repo.repository,
    [service("server", "server", "C#")],
    entries,
  );
  assert.deepEqual(repeated.architecture_graph, graph);
});

test("maps projects, references, packages, configuration, and SDK calls with evidence", (t) => {
  const repo = fixture(t);
  repo.write(
    "server/server.csproj",
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="AWSSDK.SQS" Version="3.7.0" />
    <ProjectReference Include="../data/data.csproj" />
  </ItemGroup>
</Project>
`,
  );
  repo.write(
    "server/appsettings.json",
    `{
  // Comments and trailing commas are allowed in appsettings files.
  "Logging": { "Endpoint": "https://logs.example.com" },
  "Billing": { "BaseUrl": "https://billing.example.com/v1" },
  "Local": { "Url": "http://localhost:5000" },
}
`,
  );
  repo.write(
    "server/OrdersController.cs",
    `using Amazon.SQS;
using Shop.Data;
interface IServiceCollection { }
interface ILogger { void LogInformation(string message); }
interface IAmazonKinesis { Task PutRecordAsync(string stream); }
static class ServiceCollectionExtensions {
  public static void AddScoped<TContract, TImplementation>(this IServiceCollection services) { }
}
class Startup {
  void Configure(IServiceCollection services) {
    services.AddScoped<IOrderStore, OrderStore>();
  }
}
[Route("api/orders")]
class OrdersController(IOrderStore orders, IAmazonSQS queue, IAmazonKinesis stream, ILogger logger) {
  [HttpPost]
  public async Task Create(string id) {
    // Redis would make this faster.
    var cache = "mongodb://cache.example.com";
    logger.LogInformation("Sent to Kafka");
    await orders.Save(id);
    await queue.SendMessageAsync("orders", id);
    await stream.PutRecordAsync(cache);
  }
}
`,
  );
  repo.write(
    "data/data.csproj",
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
  <ItemGroup><PackageReference Include="AWSSDK.DynamoDBv2" Version="3.7.0" /></ItemGroup>
</Project>
`,
  );
  repo.write(
    "data/OrderStore.cs",
    `using Amazon.DynamoDBv2;
namespace Shop.Data;
public interface IOrderStore { Task Save(string id); }
public class OrderStore(IAmazonDynamoDB db) : IOrderStore {
  public Task Save(string id) => db.PutItemAsync("orders", null);
}
`,
  );
  repo.write(
    "server.Tests/server.Tests.csproj",
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
  <ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0.0" /></ItemGroup>
</Project>
`,
  );
  repo.write(
    "server.Tests/UploadTests.cs",
    `using Amazon.S3;
class UploadTests(IAmazonS3 s3) { Task Run() => s3.PutObjectAsync(null); }
`,
  );

  const scan = () => extractRequestFlows(repo.repository, [service("server", "server", "C#")]);
  const result = scan();
  const graph = result.architecture_graph;
  const edge = mapEdge(graph);
  const flow = result.flows.find((item) => item.trigger.label === "POST /api/orders");

  assert.ok(flow);
  assert.equal(graph.schema_version, "2.0.0");
  assert.deepEqual(
    graph.nodes.filter((node) => node.kind !== "entrypoint").map((node) => [node.kind, node.label]),
    [
      ["service", "server"],
      ["library", "data"],
      ["database", "Amazon DynamoDB"],
      ["queue", "Amazon SQS"],
      ["external", "billing.example.com"],
    ],
  );
  assert.deepEqual(
    edge("server", "references", "data").evidence.map((item) => [item.kind, item.file]),
    [["project-reference", "server/server.csproj"]],
  );
  const publish = edge("server", "publishes", "Amazon SQS");
  assert.equal(publish.strength, "call");
  assert.equal(publish.resolution, "direct");
  assert.deepEqual(publish.evidence.map((item) => [item.kind, item.file]), [
    ["call", "server/OrdersController.cs"],
    ["injection", "server/OrdersController.cs"],
    ["package", "server/server.csproj"],
  ]);
  assert.deepEqual(publish.flow_ids, [flow.id]);
  const query = edge("data", "queries", "Amazon DynamoDB");
  assert.equal(query.strength, "call");
  assert.deepEqual(query.flow_ids, [flow.id]);
  const billing = edge("server", "calls_external", "billing.example.com");
  assert.equal(billing.strength, "wiring");
  assert.deepEqual(
    billing.evidence.map((item) => [item.kind, item.file, item.symbol]),
    [["configuration", "server/appsettings.json", "Billing.BaseUrl"]],
  );
  assert.deepEqual(
    [graph.summary.services, graph.summary.libraries, graph.summary.technologies, graph.summary.call_sites],
    [1, 1, 3, 2],
  );
  assert.deepEqual(graph.flows, [{ id: flow.id, label: "POST /api/orders", service: "server" }]);
  assert.deepEqual(scan().architecture_graph, graph);
});

test("attributes registrations, listeners, and wrappers only with corroborating evidence", (t) => {
  const repo = fixture(t);
  repo.write(
    "server/server.csproj",
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup><ProjectReference Include="../adapters/adapters.csproj" /></ItemGroup>
</Project>
`,
  );
  repo.write(
    "server/Startup.cs",
    `using Amazon.SQS;
using Shop.Adapters;
class Startup {
  void ConfigureServices(IServiceCollection services) {
    services.AddAWSService<IAmazonSQS>();
    services.AddFifoSqsQueueListener<OrderListener>();
    services.AddAdapters();
  }
}
class OrderListener { }
`,
  );
  repo.write(
    "server/DevicesController.cs",
    `using Contoso.OpenSearch.Abstractions;
using Contoso.Messaging;
interface IGreengrassRegistrar { Task RegisterGreengrass(string device); }
[Route("api/devices")]
class DevicesController(IGreengrassRegistrar registrar, IEntityProvider entities, IJobQueuePublisher jobs) {
  [HttpPost]
  public async Task Register(string device) {
    await registrar.RegisterGreengrass(device);
    await entities.Query(device);
    await jobs.EnqueueAsync(device);
  }
}
`,
  );
  repo.write(
    "server/Reports.cs",
    `using Contoso.OpenSearch.Abstractions;
class Reports(IEntityProvider entities) {
  public Task Run() => entities.Query("all");
}
`,
  );
  repo.write(
    "adapters/adapters.csproj",
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
</Project>
`,
  );
  repo.write(
    "adapters/ServiceCollectionExtensions.cs",
    `using Amazon.EventBridge;
namespace Shop.Adapters;
public static class ServiceCollectionExtensions {
  public static IServiceCollection AddAdapters(this IServiceCollection services) {
    services.AddSingleton<IAmazonEventBridge>(new AmazonEventBridgeClient());
    return services;
  }
}
`,
  );
  repo.write(
    "adapters/EventPublisher.cs",
    `using Amazon.EventBridge;
namespace Shop.Adapters;
public class EventPublisher(IAmazonEventBridge events) {
  public Task Publish() => events.PutEventsAsync(null);
}
`,
  );

  const result = extractRequestFlows(repo.repository, [service("server", "server", "C#")]);
  const graph = result.architecture_graph;
  const edge = mapEdge(graph);
  const flow = result.flows.find((item) => item.trigger.label === "POST /api/devices");

  assert.deepEqual(
    graph.nodes
      .filter((node) => ["database", "queue", "external"].includes(node.kind))
      .map((node) => node.label),
    ["Amazon EventBridge", "Amazon SQS", "OpenSearch"],
  );
  const consumes = edge("server", "consumes", "Amazon SQS");
  assert.equal(consumes.strength, "wiring");
  assert.deepEqual(
    consumes.evidence.map((item) => item.symbol),
    ["AddAWSService<IAmazonSQS>", "AddFifoSqsQueueListener"],
  );
  const wired = edge("server", "uses", "Amazon EventBridge");
  assert.equal(wired.strength, "wiring");
  assert.match(
    wired.evidence[0].reason,
    /through ServiceCollectionExtensions\.AddAdapters \(adapters\/ServiceCollectionExtensions\.cs:\d+\)/,
  );
  assert.equal(edge("adapters", "publishes", "Amazon EventBridge").strength, "call");
  const search = edge("server", "queries", "OpenSearch");
  assert.equal(search.strength, "call");
  assert.equal(search.resolution, "inferred");
  assert.deepEqual(
    search.evidence.map((item) => item.symbol),
    ["IEntityProvider.Query", "IEntityProvider.Query"],
  );
  assert.match(search.evidence[0].reason, /every file that declares IEntityProvider imports Contoso\.OpenSearch\.Abstractions/);
  assert.deepEqual(search.flow_ids, [flow.id]);
  assert.ok(!graph.edges.some((item) => item.evidence.some((evidence) =>
    /RegisterGreengrass|IJobQueuePublisher/.test(evidence.symbol))));
});

test("resolves minimal APIs and OData conventions with Roslyn symbols", (t) => {
  const repo = fixture(t);
  repo.write(
    "server/Routes.cs",
    `class RouteBuilder { }
static class RouteExtensions {
  public static void MapGet(this RouteBuilder app, string route, Func<Task> handler) { }
  public static void AddOData(this object services, string prefix) { }
}
static class HealthEndpoint {
  public static Task Handle() => Task.CompletedTask;
}
class Routes {
  void Configure(RouteBuilder app, object services) {
    app.MapGet("/health", HealthEndpoint.Handle);
    services.AddOData("odata/v{version}");
  }
}
`,
  );
  repo.write(
    "server/OrdersController.cs",
    `class ODataController { }
class OrdersController : ODataController {
  public Task Get() => Task.CompletedTask;
}
`,
  );

  const result = extractRequestFlows(
    repo.repository,
    [service("server", "server", "C#")],
  );

  assert.deepEqual(
    result.flows.map((flow) => flow.trigger.label),
    ["GET /odata/v{version}/Orders", "GET /health"],
  );
  assert.ok(result.flows.every((flow) => flow.steps[1].confidence === "medium"));
});

test("uses overload symbols instead of matching method names", (t) => {
  const repo = fixture(t);
  repo.write(
    "server/OverloadsController.cs",
    `[Route("overloads")]
class OverloadsController {
  private readonly OverloadService _service;
  [HttpGet("{id}")]
  public Task Get(string id) => _service.Load(id);
}
class OverloadService {
  public Task Load(int id) => Task.CompletedTask;
  public Task Load(string id) => Task.CompletedTask;
}
`,
  );

  const flow = extractRequestFlows(
    repo.repository,
    [service("server", "server", "C#")],
  ).flows[0];

  assert.equal(flow.steps[2].symbol, "OverloadService.Load");
  assert.equal(flow.steps[2].line, 9);
  assert.match(flow.steps[2].evidence[0], /string/);
});

test("study mode analyzes local source without loading or restoring projects", (t) => {
  const repo = fixture(t);
  repo.write(
    "server/server.csproj",
    `<Project Sdk="Unavailable.Company.Sdk/99.0.0">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
</Project>
`,
  );
  repo.write(
    "server/StudyController.cs",
    `using Microsoft.AspNetCore.Mvc;
using Unavailable.Company.Client;
[Route("study")]
public class StudyController : ControllerBase {
  private readonly StudyService _service = new();
  [HttpGet("{id}")]
  public void Get(string id) { _service.Load(id); }
}
public class StudyService {
  private MissingClient _client = null!;
  public void Load(int id) { }
  public void Load(string id) { _client.Send(id); }
}
`,
  );

  const analyze = () => extractRequestFlows(
    repo.repository,
    [service("server", "server", "C#")],
    {},
  );
  const first = analyze();
  const second = analyze();

  assert.equal(first.analysis.mode, "study");
  assert.equal(first.analysis.completeness, "partial");
  assert.equal(first.generator.strategy, "roslyn-source-study");
  assert.ok(first.warnings.some((warning) => warning.code === "study-mode-partial"));
  assert.ok(!first.warnings.some((warning) => warning.code === "project-load-failed"));
  assert.equal(first.flows[0].trigger.label, "GET /study/{id}");
  assert.equal(first.flows[0].steps[2].line, 12);
  assert.ok(first.flows[0].steps.some((step) =>
    step.kind === "inference-limit" && step.confidence === "low"
  ));
  assert.deepEqual(first, second);
});

test("resolves DI calls across project references", (t) => {
  const repo = fixture(t);
  repo.write(
    "core/core.csproj",
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
</Project>
`,
  );
  repo.write(
    "core/OrderService.cs",
    `namespace Example.Core;
public interface IOrderService { Task Load(string id); }
public class OrderService : IOrderService {
  public Task Load(string id) => Task.CompletedTask;
}
`,
  );
  repo.write(
    "server/server.csproj",
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup><ProjectReference Include="../core/core.csproj" /></ItemGroup>
</Project>
`,
  );
  repo.write(
    "server/CrossProjectController.cs",
    `using Example.Core;
interface IServiceCollection { }
static class ServiceCollectionExtensions {
  public static void AddScoped<TContract, TImplementation>(this IServiceCollection services) { }
}
class Startup {
  void Configure(IServiceCollection services) {
    services.AddScoped<IOrderService, OrderService>();
  }
}
[Route("cross-project")]
class CrossProjectController {
  private readonly IOrderService _orders;
  [HttpGet("{id}")]
  public Task Get(string id) => _orders.Load(id);
}
`,
  );

  const flow = extractRequestFlows(
    repo.repository,
    [service("server", "server", "C#")],
  ).flows[0];

  assert.equal(flow.steps[2].symbol, "OrderService.Load");
  assert.equal(flow.steps[2].file, "core/OrderService.cs");
  assert.equal(flow.steps[2].confidence, "medium");
  assert.match(flow.steps[2].evidence[0], /explicit \.NET DI registration/);
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
    `class MessageHandler<T> { }
class DeviceChangedMessage { }
interface IQueuePublisher { Task Publish(object message); }
class DeviceChangedHandler : MessageHandler<DeviceChangedMessage> {
private readonly IQueuePublisher _publisher;
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
    `class Entity { }
interface IEntityProvider { Task Query<T>(); }
[Route("entities")]
class Controller {
private readonly IEntityProvider _entityProvider;
[HttpGet]
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
  assert.match(shallow.flows[0].steps.at(-1).label, /data provider/);
  assert.ok(shallow.flows[0].branches.length >= 1);
  assert.ok(shallow.flows[0].branches.some((branch) =>
    branch.some((step) => step.kind === "inference-limit")));
});

test("names boundaries only from matching receiver and source evidence", (t) => {
  const repo = fixture(t);
  repo.write(
    "server/BoundaryController.cs",
    `interface IDBRepository { Task Load(); }
interface IAmazonIotData { Task Publish(); }
interface IMqttPublisher { Task Publish(); }
interface INotificationClient { Task Send(); }
interface IEventBridgeJobQueuePublisher { Task Publish(string target); }
interface IHttpClient { Task GetAsync(); }
[Route("boundary")]
class BoundaryController {
private readonly IDBRepository _dbRepository;
private readonly IAmazonIotData _iotData;
private readonly IMqttPublisher _mqttPublisher;
private readonly INotificationClient _notificationClient;
private readonly IEventBridgeJobQueuePublisher _jobQueue;
private readonly IHttpClient _deviceClient;
[HttpPost]
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
  assert.ok(labels.some((label) => /HTTP via IHttpClient\.GetAsync/.test(label)));
});

test("honors depth and flow caps and ignores test/generated/vendor code", (t) => {
  const repo = fixture(t);
  repo.write(
    "app/App.cs",
    `[Route("ok")]
class App {
[HttpGet]
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

test("analyzes source when the project SDK is unavailable", (t) => {
  const repo = fixture(t);
  repo.write(
    "broken/broken.csproj",
    '<Project Sdk="Missing.Company.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
  );
  repo.write("broken/Program.cs", "public static class Program { public static void Main() {} }\n");
  repo.write(
    "broken/FakeController.cs",
    '[Route("should-not-appear")]\nclass FakeController { [HttpGet] public void Get() {} }\n',
  );

  const result = extractRequestFlows(
    repo.repository,
    [service("broken", "broken", "C#")],
  );

  assert.equal(result.flows.length, 1);
  assert.equal(result.flows[0].trigger.label, "GET /should-not-appear");
  assert.equal(result.analysis.mode, "study");
  assert.ok(!result.warnings.some((warning) => warning.code === "project-load-failed"));
});

test("builds a plain-English story for a background heartbeat job", (t) => {
  const repo = fixture(t);
  repo.write(
    "server/Queue/JobQueueMessageTypeDiscriminator.cs",
    `using Acme.Shared.Models.TenancyMessages;
namespace Acme.DeviceAS.Server.Queue;
class JobQueueMessageTypeDiscriminator {
  static System.Type Resolve(string name) => name switch {
    "TenancyDevicesHeartbeat" => typeof(TenancyDevicesHeartbeat),
  };
}
`,
  );
  repo.write(
    "server/Queue/HandlerContracts.cs",
    `namespace Acme.Shared.Models.TenancyMessages {
public class TenancyDevicesHeartbeat { public string TenantID { get; set; } = ""; }
}
namespace Acme.DeviceAS.Server.Queue.Handlers {
public abstract class TenancyEventMessageHandlerBase<T> {
    protected abstract Task<bool> HandleMessage(T message);
}
public interface IMetricsPublisher { void Histogram(string name, int value); }
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
    "server/Core/OpenSearchContracts.cs",
    `namespace Acme.OpenSearch.Abstractions;
public interface IEntityProvider { }
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
    { outsideRepo: false, ownerHint: undefined, namespace: undefined },
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
  assert.match(story.summary, /^Runs when DeviceAS itself publishes a "TenancyDevicesHeartbeat" message\./);
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
    '[Route("health")]\nclass HealthController { [HttpGet] public int Get() { return 1; } }\n',
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
