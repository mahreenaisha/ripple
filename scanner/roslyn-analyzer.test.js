"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { dotnetMajor } = require("./roslyn-analyzer");

test("parses supported .NET SDK major versions", () => {
  assert.equal(dotnetMajor("10.0.403"), 10);
  assert.equal(dotnetMajor("11.0.100-preview.1"), 11);
  assert.equal(dotnetMajor("8.0.427"), 8);
  assert.equal(dotnetMajor("not-a-version"), null);
});
