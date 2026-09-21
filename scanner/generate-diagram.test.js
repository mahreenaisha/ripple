"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  generateDiagram,
  graphToHtml,
  graphToMermaid,
  graphToSvg,
} = require("./generate-diagram");

const GRAPH = {
  nodes: [
    {
      id: "api",
      type: "service",
      language: "Node.js",
      entry_points_count: 2,
      dependents: [],
      spof_candidate: true,
      metadata: {
        is_spof: true,
        status: "active",
        owner: "Platform",
        gotchas: ["Deploy first"],
        lines_of_code: 10,
      },
    },
    {
      id: "PostgreSQL",
      type: "database",
      language: null,
      entry_points_count: 0,
      spof_candidate: true,
    },
  ],
  edges: [
    {
      from: "api",
      to: "PostgreSQL",
      type: "queries",
      count: 3,
      confidence: "high",
    },
  ],
};

test("generates Mermaid with endpoint counts, weights, and risk styling", () => {
  const mermaid = graphToMermaid(GRAPH);
  assert.match(mermaid, /^flowchart LR/);
  assert.match(mermaid, /api<br\/>2 entry points<br\/>SPOF/);
  assert.match(mermaid, /queries ×3 \(high\)/);
  assert.match(mermaid, /class node0 danger/);
});

test("generates a standalone accessible SVG", () => {
  const svg = graphToSvg(GRAPH);
  assert.match(svg, /^<svg xmlns=/);
  assert.match(svg, /role="img"/);
  assert.match(svg, /api → PostgreSQL: queries ×3 \(high\)/);
  assert.match(svg, /red = service depended on by more than 3 others/);
  assert.match(svg, /<\/svg>\n$/);
});

test("generates interactive HTML with embedded service entries", () => {
  const html = graphToHtml(GRAPH, {
    api: {
      entries: [
        {
          type: "API",
          endpoint: "GET /health",
          file: "api/server.js",
          line: 12,
        },
      ],
    },
  });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Click a service/);
  assert.match(html, /GET \/health/);
  assert.match(html, /Deploy first/);
  assert.match(html, /showService/);
});

test("writes Mermaid, SVG, and HTML artifacts", (t) => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "diagram-"));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));

  const result = generateDiagram(GRAPH, outputDirectory, {});
  assert.equal(path.basename(result.mermaidPath), "architecture.mmd");
  assert.equal(path.basename(result.svgPath), "architecture.svg");
  assert.equal(path.basename(result.htmlPath), "architecture.html");
  assert.ok(fs.statSync(result.mermaidPath).size > 0);
  assert.ok(fs.statSync(result.svgPath).size > 0);
  assert.ok(fs.statSync(result.htmlPath).size > 0);
});
