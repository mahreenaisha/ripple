"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "bin",
  "obj",
  "dist",
  "build",
  "coverage",
  ".terraform",
  "vendor",
]);
const MERMAID_FILE = /\.(mmd|mermaid)$/i;
const UML_FILE = /\.(uml|puml|plantuml)$/i;
const MAX_CODE = 20000;
const MAX_ITEMS = 40;
const MERMAID_BLOCK = /```mermaid\s*\n([\s\S]*?)```/g;

function walk(rootPath, directory = rootPath, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) {
        walk(rootPath, path.join(directory, entry.name), files);
      }
    } else if (entry.isFile()) {
      files.push(path.relative(rootPath, path.join(directory, entry.name)).split(path.sep).join("/"));
    }
  }
  return files;
}

function titleFromPath(relativePath) {
  const base = path.basename(relativePath).replace(/\.[^.]+$/, "");
  const words = base.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function isDesignDoc(relativePath) {
  return /\.md$/i.test(relativePath) && /(^|\/)(docs?|design|adr|architecture)\//i.test(relativePath);
}

function clip(code) {
  return code.length > MAX_CODE ? code.slice(0, MAX_CODE) : code;
}

function collectTeamDiagrams(rootPath) {
  const diagrams = [];
  const docs = [];

  for (const relativePath of walk(rootPath).sort()) {
    const absolutePath = path.join(rootPath, relativePath);
    if (MERMAID_FILE.test(relativePath) || UML_FILE.test(relativePath)) {
      diagrams.push({
        title: titleFromPath(relativePath),
        path: relativePath,
        format: MERMAID_FILE.test(relativePath) ? "mermaid" : "plantuml",
        code: clip(fs.readFileSync(absolutePath, "utf8")),
      });
      continue;
    }
    if (!isDesignDoc(relativePath)) {
      continue;
    }
    const text = fs.readFileSync(absolutePath, "utf8");
    const heading = text.match(/^#\s+(.+)$/m);
    const lines = text.split("\n");
    docs.push({
      title: heading ? heading[1].trim() : titleFromPath(relativePath),
      path: relativePath,
      lines: lines.length,
    });
    let index = 0;
    for (const match of text.matchAll(MERMAID_BLOCK)) {
      index += 1;
      const line = text.slice(0, match.index).split("\n").length;
      diagrams.push({
        title: `${heading ? heading[1].trim() : titleFromPath(relativePath)} (diagram ${index})`,
        path: relativePath,
        line,
        format: "mermaid",
        code: clip(match[1]),
      });
    }
  }

  return {
    diagrams: diagrams.slice(0, MAX_ITEMS),
    docs: docs.slice(0, MAX_ITEMS),
  };
}

module.exports = { collectTeamDiagrams };
