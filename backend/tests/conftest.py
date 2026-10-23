from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from backend.models import RepositoryRecord
from backend.registry import RepositoryRegistry


def git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


@pytest.fixture
def deviceas_repo(tmp_path: Path) -> Path:
    root = tmp_path / "wcc-deviceas"
    files = {
        "README.md": "# DeviceAS\n\nDevice service source repository.\n",
        "docker-compose.yml": "services:\n  deviceas:\n    build: ./server\n",
        "server/Waters.DeviceAS.Server/Waters.DeviceAS.Server.csproj": (
            '<Project Sdk="Microsoft.NET.Sdk.Web">\n'
            "  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>\n"
            "</Project>\n"
        ),
        "server/Waters.DeviceAS.Server/Program.cs": (
            "var builder = WebApplication.CreateBuilder(args);\n"
            "builder.Services.AddScoped<IDeviceService, DeviceService>();\n"
            "var app = builder.Build();\napp.MapControllers();\napp.Run();\n"
        ),
        "server/Waters.DeviceAS.Server/Controllers/DevicesController.cs": (
            "[ApiController]\n[Route(\"api/devices\")]\n"
            "public class DevicesController : ControllerBase\n"
            "{\n  [HttpGet]\n  public IActionResult Get() => Ok();\n}\n"
        ),
        "server/Waters.DeviceAS.Server/appsettings.json": '{"Logging":{"LogLevel":{"Default":"Information"}}}\n',
        "server/Waters.DeviceAS.Server/.env": "SECRET=never-read\n",
        "server/Waters.DeviceAS.Server/bin/generated.dll": "not-real\n",
        "utilities/Waters.DeviceAS.Migration/Program.cs": (
            "public class Program { public static void Main(string[] args) {} }\n"
        ),
        "infrastructure/terraform/main.tf": 'resource "example" "deviceas" {}\n',
        "tests/DeviceAS.Tests/DeviceTests.cs": "public class DeviceTests {}\n",
    }
    for relative, content in files.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    git(root, "init")
    git(root, "config", "user.email", "ripple@example.test")
    git(root, "config", "user.name", "Ripple Tests")
    git(root, "add", ".")
    git(root, "commit", "-m", "fixture")
    return root


@pytest.fixture
def registry(tmp_path: Path, deviceas_repo: Path) -> RepositoryRegistry:
    result = RepositoryRegistry(tmp_path / "data")
    result.add(deviceas_repo, "DeviceAS")
    return result


@pytest.fixture
def repository(registry: RepositoryRegistry) -> RepositoryRecord:
    return registry.list()[0]

