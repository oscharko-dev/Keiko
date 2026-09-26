import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readJsonFile } from "../lib/json.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "keiko-json-test-"));
  roots.push(root);
  return root;
}

describe("readJsonFile", () => {
  it("parses a UTF-8 JSON file", () => {
    const path = join(tempRoot(), "value.json");
    writeFileSync(path, '{"name":"keiko","count":3}\n', "utf8");
    expect(readJsonFile(path)).toEqual({ name: "keiko", count: 3 });
  });

  it("propagates a missing file unchanged", () => {
    expect(() => readJsonFile(join(tempRoot(), "absent.json"))).toThrow(/ENOENT/u);
  });

  it("propagates invalid JSON unchanged", () => {
    const path = join(tempRoot(), "broken.json");
    writeFileSync(path, "{not json", "utf8");
    expect(() => readJsonFile(path)).toThrow(SyntaxError);
  });
});
