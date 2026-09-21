#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function mermaidEscape(value) {
  return String(value).replaceAll('"', "'");
}

function mermaidId(index) {
  return `node${index}`;
}

function isDangerousService(node) {
  return (
    node.type === "service" &&
    (node.metadata?.is_spof === true || (node.dependents?.length || 0) > 3)
  );
}

function riskLabel(node) {
  return node.metadata?.is_spof === true ? "SPOF" : "SPOF risk";
}

function graphToMermaid(graph) {
  const nodeIds = new Map(
    graph.nodes.map((node, index) => [node.id, mermaidId(index)]),
  );
  const lines = ["flowchart LR"];
  const groups = [
    ["Services", "service"],
    ["Databases", "database"],
    ["External systems", "external_api"],
  ];

  for (const [label, type] of groups) {
    const nodes = graph.nodes.filter((node) => node.type === type);
    if (nodes.length === 0) {
      continue;
    }
    const groupId = type.replaceAll("_", "");
    lines.push(`  subgraph ${groupId} [${label}]`);
    for (const node of nodes) {
      const endpointLabel =
        type === "service"
          ? `<br/>${node.entry_points_count} entry points`
          : "";
      const riskSuffix = isDangerousService(node)
        ? `<br/>${riskLabel(node)}`
        : "";
      const display = `${mermaidEscape(node.id)}${endpointLabel}${riskSuffix}`;
      if (type === "database") {
        lines.push(`    ${nodeIds.get(node.id)}[("${display}")]`);
      } else {
        lines.push(`    ${nodeIds.get(node.id)}["${display}"]`);
      }
    }
    lines.push("  end");
  }

  for (const edge of graph.edges) {
    const arrow = edge.type === "imports" ? "-.->" : "-->";
    lines.push(
      `  ${nodeIds.get(edge.from)} ${arrow}|"${edge.type} ×${edge.count} (${edge.confidence})"| ${nodeIds.get(edge.to)}`,
    );
  }
  lines.push(
    "  classDef service fill:#dbeafe,stroke:#2563eb,color:#172554",
    "  classDef database fill:#d1fae5,stroke:#059669,color:#064e3b",
    "  classDef external fill:#f1f5f9,stroke:#64748b,color:#0f172a",
    "  classDef danger fill:#fecaca,stroke:#dc2626,color:#7f1d1d,stroke-width:3px",
  );
  for (const node of graph.nodes) {
    const className = isDangerousService(node)
      ? "danger"
      : node.type === "service"
        ? "service"
        : node.type === "database"
          ? "database"
          : "external";
    lines.push(`  class ${nodeIds.get(node.id)} ${className}`);
  }
  return `${lines.join("\n")}\n`;
}

function nodePositions(graph, height) {
  const positions = new Map();
  const services = graph.nodes.filter((node) => node.type === "service");
  const dependencies = graph.nodes.filter((node) => node.type !== "service");

  services.forEach((node, index) => {
    positions.set(node.id, {
      x: 70,
      y: ((index + 1) * height) / (services.length + 1),
      width: 330,
      height: 62,
    });
  });
  dependencies.forEach((node, index) => {
    positions.set(node.id, {
      x: 880,
      y: ((index + 1) * height) / (dependencies.length + 1),
      width: 390,
      height: 54,
    });
  });
  return positions;
}

function graphToSvg(graph) {
  const dependencyCount = graph.nodes.filter(
    (node) => node.type !== "service",
  ).length;
  const height = Math.max(720, dependencyCount * 68 + 100);
  const width = 1340;
  const positions = nodePositions(graph, height);

  const edgeMarkup = graph.edges
    .map((edge, index) => {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) {
        return "";
      }
      const isServiceTarget = graph.nodes.find((node) => node.id === edge.to)?.type === "service";
      let d;
      if (isServiceTarget) {
        const startX = from.x;
        const endX = to.x;
        const bendX = 25 - index * 3;
        d = `M ${startX} ${from.y} C ${bendX} ${from.y}, ${bendX} ${to.y}, ${endX} ${to.y}`;
      } else {
        const startX = from.x + from.width;
        const endX = to.x;
        const controlX = startX + (endX - startX) / 2;
        d = `M ${startX} ${from.y} C ${controlX} ${from.y}, ${controlX} ${to.y}, ${endX} ${to.y}`;
      }
      const dash = edge.type === "imports" ? ' stroke-dasharray="7 5"' : "";
      const widthValue = Math.min(6, 1.2 + Math.log2(edge.count + 1));
      return [
        `<path class="edge edge-${edge.type}" d="${d}" stroke-width="${widthValue.toFixed(2)}"${dash} marker-end="url(#arrow)">`,
        `<title>${xmlEscape(`${edge.from} → ${edge.to}: ${edge.type} ×${edge.count} (${edge.confidence})`)}</title>`,
        "</path>",
      ].join("");
    })
    .join("\n");

  const nodeMarkup = graph.nodes
    .map((node) => {
      const position = positions.get(node.id);
      const dangerous = isDangerousService(node);
      const className = `node node-${node.type}${dangerous ? " danger" : ""}`;
      const details =
        node.type === "service"
          ? `${node.language} · ${node.entry_points_count} entry points`
          : node.type === "database"
            ? "database"
            : "external system";
      return [
        `<g class="${className}" data-node-id="${xmlEscape(node.id)}" data-node-type="${node.type}"${node.type === "service" ? ' role="button" tabindex="0"' : ""}>`,
        `<title>${xmlEscape(`${node.id} — ${details}`)}</title>`,
        `<rect x="${position.x}" y="${position.y - position.height / 2}" width="${position.width}" height="${position.height}" rx="9"/>`,
        `<text class="node-title" x="${position.x + 16}" y="${position.y - 3}">${xmlEscape(node.id)}</text>`,
        `<text class="node-detail" x="${position.x + 16}" y="${position.y + 18}">${xmlEscape(details)}${dangerous ? ` · ${riskLabel(node)}` : ""}</text>`,
        "</g>",
      ].join("");
    })
    .join("\n");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">`,
    '<title id="title">Repository dependency graph</title>',
    `<desc id="description">${graph.nodes.length} nodes and ${graph.edges.length} weighted dependency edges.</desc>`,
    "<defs>",
    '<marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#64748b"/></marker>',
    "</defs>",
    "<style>",
    "svg{background:#fff;font-family:ui-sans-serif,system-ui,sans-serif}.edge{fill:none;stroke:#64748b;opacity:.62}.edge-queries{stroke:#2563eb}.edge-publishes,.edge-subscribes{stroke:#7c3aed}.edge-imports{stroke:#94a3b8}.node rect{fill:#f8fafc;stroke:#64748b;stroke-width:1.5}.node-service{cursor:pointer}.node-service rect{fill:#eff6ff;stroke:#2563eb}.node-service:focus rect{stroke-width:3}.node-database rect{fill:#ecfdf5;stroke:#059669}.node-external_api rect{fill:#f8fafc;stroke:#64748b}.node.danger rect{fill:#fee2e2;stroke:#dc2626;stroke-width:3}.node-title{font-size:14px;font-weight:500;fill:#0f172a}.node-detail{font-size:11px;font-weight:400;fill:#475569}.heading{font-size:15px;font-weight:500;fill:#334155}.legend{font-size:11px;fill:#475569}",
    "</style>",
    '<text class="heading" x="70" y="32">Services</text>',
    '<text class="heading" x="880" y="32">Dependencies</text>',
    edgeMarkup,
    nodeMarkup,
    `<g transform="translate(70,${height - 18})"><text class="legend" x="0" y="0">Line width = unique evidence sites · dashed = compile-time import · red = service depended on by more than 3 others</text></g>`,
    "</svg>",
    "",
  ].join("\n");
}

function graphToHtml(graph, entryPoints = {}) {
  const embeddedGraph = JSON.stringify(graph).replaceAll("<", "\\u003c");
  const embeddedEntries = JSON.stringify(entryPoints).replaceAll("<", "\\u003c");
  const svg = graphToSvg(graph);
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>Repository architecture</title>",
    "<style>",
    "*{box-sizing:border-box}body{margin:0;background:#f8fafc;color:#0f172a;font-family:ui-sans-serif,system-ui,sans-serif}header{padding:16px 20px;border-bottom:1px solid #cbd5e1;background:#fff}h1{font-size:20px;margin:0 0 4px}header p{margin:0;color:#475569;font-size:13px}.layout{display:grid;grid-template-columns:minmax(0,1fr) 380px;height:calc(100vh - 78px)}.diagram{overflow:auto;padding:12px;background:#fff}.diagram svg{min-width:1000px;width:100%;height:auto}.details{border-left:1px solid #cbd5e1;padding:18px;overflow:auto;background:#f8fafc}.details h2{font-size:18px;margin:0 0 6px}.summary{color:#475569;font-size:13px;margin:0 0 14px}.dependencies{font-size:12px;margin:0 0 16px;padding-left:18px}.entry-list{list-style:none;margin:0;padding:0}.entry{padding:10px 0;border-top:1px solid #e2e8f0}.entry-name{font-size:13px;font-weight:500;overflow-wrap:anywhere}.entry-location{font-size:11px;color:#64748b;margin-top:3px;overflow-wrap:anywhere}.badge{display:inline-block;font-size:10px;line-height:18px;padding:0 6px;margin-right:6px;border-radius:10px;background:#e2e8f0;color:#334155}.empty{font-size:13px;color:#64748b}.node-service.selected rect{stroke:#0f172a!important;stroke-width:4!important}@media(max-width:800px){.layout{display:block;height:auto}.diagram{max-height:55vh}.details{border-left:0;border-top:1px solid #cbd5e1;min-height:45vh}}",
    "</style>",
    "</head>",
    "<body>",
    "<header><h1>Repository architecture</h1><p>Click a service to inspect its APIs, CLIs, and exported symbols. Hover nodes and edges for details.</p></header>",
    '<main class="layout">',
    `<section class="diagram" aria-label="Dependency graph">${svg}</section>`,
    '<aside class="details" aria-live="polite">',
    '<h2 id="service-name">Select a service</h2>',
    '<p class="summary" id="service-summary">Service details appear here.</p>',
    '<div id="human-section" hidden><strong>Human metadata</strong><ul class="dependencies" id="human-list"></ul></div>',
    '<div id="gotcha-section" hidden><strong>Gotchas</strong><ul class="dependencies" id="gotcha-list"></ul></div>',
    '<div id="dependency-section" hidden><strong>Dependencies</strong><ul class="dependencies" id="dependency-list"></ul></div>',
    '<strong id="entry-heading" hidden>Entry points</strong>',
    '<ul class="entry-list" id="entry-list"></ul>',
    "</aside>",
    "</main>",
    "<script>",
    `const graph=${embeddedGraph};`,
    `const entryPoints=${embeddedEntries};`,
    "const byId=new Map(graph.nodes.map(node=>[node.id,node]));",
    "const serviceName=document.getElementById('service-name');",
    "const summary=document.getElementById('service-summary');",
    "const humanSection=document.getElementById('human-section');",
    "const humanList=document.getElementById('human-list');",
    "const gotchaSection=document.getElementById('gotcha-section');",
    "const gotchaList=document.getElementById('gotcha-list');",
    "const dependencySection=document.getElementById('dependency-section');",
    "const dependencyList=document.getElementById('dependency-list');",
    "const entryHeading=document.getElementById('entry-heading');",
    "const entryList=document.getElementById('entry-list');",
    "function showService(id){",
    "  const node=byId.get(id); if(!node||node.type!=='service')return;",
    "  document.querySelectorAll('.node-service').forEach(item=>item.classList.toggle('selected',item.dataset.nodeId===id));",
    "  serviceName.textContent=node.id;",
    "  summary.textContent=`${node.language||'Unknown language'} · ${node.entry_points_count} API/CLI entry points · ${node.metadata?.lines_of_code||0} lines of code`;",
    "  humanList.replaceChildren();",
    "  const humanValues=[`Status: ${node.metadata?.status||'active'}`,`Owner: ${node.metadata?.owner||'Unassigned'}`,`SPOF: ${node.metadata?.is_spof===true?'yes':'no'}`];",
    "  for(const value of humanValues){const item=document.createElement('li');item.textContent=value;humanList.append(item)}humanSection.hidden=false;",
    "  gotchaList.replaceChildren();const gotchas=Array.isArray(node.metadata?.gotchas)?node.metadata.gotchas:[];",
    "  for(const value of gotchas){const item=document.createElement('li');item.textContent=value;gotchaList.append(item)}gotchaSection.hidden=gotchas.length===0;",
    "  dependencyList.replaceChildren();",
    "  for(const dependency of node.dependencies_on||[]){const item=document.createElement('li');item.textContent=dependency;dependencyList.append(item)}",
    "  dependencySection.hidden=(node.dependencies_on||[]).length===0;",
    "  const entries=entryPoints[id]?.entries||[]; entryList.replaceChildren();",
    "  entryHeading.hidden=false; entryHeading.textContent=`Entry points (${entries.length})`;",
    "  if(entries.length===0){const empty=document.createElement('li');empty.className='empty';empty.textContent='No entry points detected.';entryList.append(empty);return}",
    "  const fragment=document.createDocumentFragment();",
    "  for(const entry of entries){",
    "    const item=document.createElement('li');item.className='entry';",
    "    const name=document.createElement('div');name.className='entry-name';",
    "    const badge=document.createElement('span');badge.className='badge';badge.textContent=entry.type;",
    "    name.append(badge,document.createTextNode(entry.endpoint));",
    "    const location=document.createElement('div');location.className='entry-location';location.textContent=`${entry.file}:${entry.line}`;",
    "    item.append(name,location);fragment.append(item);",
    "  }",
    "  entryList.append(fragment);",
    "}",
    "for(const item of document.querySelectorAll('.node-service')){",
    "  item.addEventListener('click',()=>showService(item.dataset.nodeId));",
    "  item.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();showService(item.dataset.nodeId)}});",
    "}",
    "const firstService=graph.nodes.find(node=>node.type==='service');if(firstService)showService(firstService.id);",
    "</script>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function generateDiagram(graph, outputPath, entryPoints = {}) {
  const outputDirectory = path.resolve(outputPath);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const mermaidPath = path.join(outputDirectory, "architecture.mmd");
  const svgPath = path.join(outputDirectory, "architecture.svg");
  const htmlPath = path.join(outputDirectory, "architecture.html");
  fs.writeFileSync(mermaidPath, graphToMermaid(graph));
  fs.writeFileSync(svgPath, graphToSvg(graph));
  fs.writeFileSync(htmlPath, graphToHtml(graph, entryPoints));
  return { mermaidPath, svgPath, htmlPath };
}

function runCli(argv) {
  if (!argv[2]) {
    console.error(
      "Usage: node scanner/generate-diagram.js <graph-json> [output-directory] [entry-points-json]",
    );
    process.exitCode = 1;
    return;
  }
  try {
    const graphPath = path.resolve(argv[2]);
    const graph = JSON.parse(fs.readFileSync(graphPath, "utf8"));
    const outputDirectory = argv[3] || path.dirname(graphPath);
    const entryPoints = argv[4]
      ? JSON.parse(fs.readFileSync(path.resolve(argv[4]), "utf8"))
      : {};
    const result = generateDiagram(graph, outputDirectory, entryPoints);
    console.log(`Mermaid: ${result.mermaidPath}`);
    console.log(`SVG: ${result.svgPath}`);
    console.log(`HTML: ${result.htmlPath}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runCli(process.argv);
}

module.exports = {
  generateDiagram,
  graphToHtml,
  graphToMermaid,
  graphToSvg,
};
