"use strict";

const fs = require("node:fs");

const SERVICE_DEFAULTS = {
  status: "active",
  is_spof: false,
  gotchas: null,
  owner: null,
};

function stripComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if ((character === '"' || character === "'") && line[index - 1] !== "\\") {
      quote = quote === character ? null : quote || character;
    } else if (character === "#" && quote === null) {
      return line.slice(0, index).trimEnd();
    }
  }
  return line.trimEnd();
}

function parseScalar(rawValue) {
  const value = rawValue.trim();
  if (value === "" || value === "null" || value === "~") {
    return null;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (value === "[]") {
    return [];
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value);
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

function parseMetadataYaml(text) {
  const metadata = {
    services: {},
    deployment_order: [],
    known_issues: [],
  };
  let section = null;
  let serviceName = null;
  let listTarget = null;

  for (const originalLine of text.split(/\r?\n/)) {
    const line = stripComment(originalLine);
    if (!line.trim()) {
      continue;
    }

    const sectionMatch = line.match(/^(services|deployment_order|known_issues):(?:\s*(.*))?$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      serviceName = null;
      listTarget = null;
      if (sectionMatch[2]?.trim() === "[]") {
        metadata[section] = [];
      }
      continue;
    }

    if (section === "services") {
      const serviceMatch = line.match(/^ {2}(?! )(.+):$/);
      if (serviceMatch) {
        serviceName = String(parseScalar(serviceMatch[1]));
        metadata.services[serviceName] = {};
        listTarget = null;
        continue;
      }

      const propertyMatch = line.match(
        /^ {4}(?! )([A-Za-z_][\w-]*):(?:\s*(.*))?$/,
      );
      if (propertyMatch && serviceName) {
        const property = propertyMatch[1];
        const rawValue = propertyMatch[2] || "";
        if (rawValue.trim() === "") {
          metadata.services[serviceName][property] = [];
          listTarget = metadata.services[serviceName][property];
        } else {
          metadata.services[serviceName][property] = parseScalar(rawValue);
          listTarget = null;
        }
        continue;
      }

      const serviceListItem = line.match(/^ {6}-\s+(.+)$/);
      if (serviceListItem && listTarget) {
        listTarget.push(parseScalar(serviceListItem[1]));
      }
      continue;
    }

    if (["deployment_order", "known_issues"].includes(section)) {
      const listItem = line.match(/^ {2}-\s+(.+)$/);
      if (listItem) {
        metadata[section].push(parseScalar(listItem[1]));
      }
    }
  }
  return metadata;
}

function mergeMetadata(metadata, services) {
  const merged = {
    services: { ...(metadata?.services || {}) },
    deployment_order: Array.isArray(metadata?.deployment_order)
      ? metadata.deployment_order
      : [],
    known_issues: Array.isArray(metadata?.known_issues)
      ? metadata.known_issues
      : [],
  };

  for (const service of services) {
    merged.services[service.name] = {
      ...SERVICE_DEFAULTS,
      ...(merged.services[service.name] || {}),
    };
  }
  return merged;
}

function yamlScalar(value) {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  return JSON.stringify(String(value));
}

function appendProperty(lines, key, value) {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`    ${key}: []`);
    } else {
      lines.push(`    ${key}:`);
      for (const item of value) {
        lines.push(`      - ${yamlScalar(item)}`);
      }
    }
  } else {
    lines.push(`    ${key}: ${yamlScalar(value)}`);
  }
}

function metadataToYaml(metadata) {
  const lines = [
    "# Human-maintained architecture metadata.",
    "# Edit this file and commit it; scanner regeneration preserves your values.",
    "services:",
  ];
  const preferredKeys = ["status", "is_spof", "gotchas", "owner"];

  for (const serviceName of Object.keys(metadata.services || {}).sort()) {
    const service = metadata.services[serviceName];
    lines.push(`  ${yamlScalar(serviceName)}:`);
    for (const key of preferredKeys) {
      appendProperty(lines, key, service[key] ?? SERVICE_DEFAULTS[key]);
    }
    for (const key of Object.keys(service).filter(
      (candidate) => !preferredKeys.includes(candidate),
    )) {
      appendProperty(lines, key, service[key]);
    }
  }

  if ((metadata.deployment_order || []).length === 0) {
    lines.push("deployment_order: []");
  } else {
    lines.push("deployment_order:");
    for (const serviceName of metadata.deployment_order) {
      lines.push(`  - ${yamlScalar(serviceName)}`);
    }
  }

  if ((metadata.known_issues || []).length === 0) {
    lines.push("known_issues: []");
  } else {
    lines.push("known_issues:");
    for (const issue of metadata.known_issues) {
      lines.push(`  - ${yamlScalar(issue)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function loadAndMergeMetadata(filePath, services) {
  const existing = fs.existsSync(filePath)
    ? parseMetadataYaml(fs.readFileSync(filePath, "utf8"))
    : null;
  return mergeMetadata(existing, services);
}

module.exports = {
  SERVICE_DEFAULTS,
  loadAndMergeMetadata,
  mergeMetadata,
  metadataToYaml,
  parseMetadataYaml,
};
