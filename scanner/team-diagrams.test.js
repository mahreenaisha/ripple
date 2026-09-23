"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { collectTeamDiagrams } = require("./team-diagrams");

function write(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

test("collects mermaid files, plantuml files, design docs and their embedded diagrams", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-team-"));
  write(root, "mermaid/system_details.mmd", "sequenceDiagram\nA->>B: hi\n");
  write(root, "deviceOnboardingSequence.uml", "@startuml\nA -> B\n@enduml\n");
  write(root, "docs/design/store.md", "# OpenSearch data model\n\nText\n\n```mermaid\ngraph TD\nA-->B\n```\n");
  write(root, "README.md", "# Not a design doc\n");
  write(root, "node_modules/pkg/x.mmd", "graph TD\n");

  const result = collectTeamDiagrams(root);

  assert.deepEqual(
    result.diagrams.map((diagram) => [diagram.path, diagram.format]),
    [
      ["deviceOnboardingSequence.uml", "plantuml"],
      ["docs/design/store.md", "mermaid"],
      ["mermaid/system_details.mmd", "mermaid"],
    ],
  );
  assert.equal(result.diagrams[0].title, "Device Onboarding Sequence");
  assert.equal(result.diagrams[1].line, 5);
  assert.match(result.diagrams[1].code, /graph TD/);
  assert.deepEqual(result.docs, [
    { title: "OpenSearch data model", path: "docs/design/store.md", lines: 9 },
  ]);
});
