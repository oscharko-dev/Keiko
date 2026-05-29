import { describe, expect, it } from "vitest";
import { classifyScripts, detectScripts } from "../../src/verification/detect.js";
import { makeWorkspace } from "./_support.js";

describe("classifyScripts — name heuristics (no regex, no ReDoS)", () => {
  it("maps a full vitest project: test, typecheck, lint, build", () => {
    const mapping = classifyScripts({
      test: "vitest run",
      typecheck: "tsc -p tsconfig.json --noEmit",
      lint: "eslint . --max-warnings=0",
      build: "tsc -p tsconfig.build.json",
      format: "prettier --write .",
    });
    expect(mapping).toEqual({
      test: "test",
      typecheck: "typecheck",
      lint: "lint",
      build: "build",
    });
  });

  it("prefers an exact `test` name over `test:watch`/`pretest`", () => {
    const mapping = classifyScripts({
      "test:watch": "vitest",
      pretest: "echo",
      test: "vitest run",
    });
    expect(mapping.test).toBe("test");
  });

  it("falls back to a substring match when no exact name exists", () => {
    const mapping = classifyScripts({
      "type-check": "tsc --noEmit",
      "lint:js": "eslint src",
    });
    expect(mapping.typecheck).toBe("type-check");
    expect(mapping.lint).toBe("lint:js");
  });

  it("recognises eslint and tsc script names without the words lint/typecheck", () => {
    const mapping = classifyScripts({ "eslint-check": "eslint .", tsc: "tsc --noEmit" });
    expect(mapping.lint).toBe("eslint-check");
    expect(mapping.typecheck).toBe("tsc");
  });

  it("returns undefined for kinds with no matching script", () => {
    const mapping = classifyScripts({ start: "node ." });
    expect(mapping).toEqual({
      test: undefined,
      typecheck: undefined,
      lint: undefined,
      build: undefined,
    });
  });
});

describe("detectScripts — reads package.json through WorkspaceFs", () => {
  it("detects all scripts from a real fixture workspace", () => {
    const ws = makeWorkspace({
      scripts: { test: "vitest run", typecheck: "tsc --noEmit", lint: "eslint .", build: "tsc" },
    });
    const catalog = detectScripts(ws.info);
    expect(catalog.scripts.test).toBe("vitest run");
    expect(catalog.mapping).toEqual({
      test: "test",
      typecheck: "typecheck",
      lint: "lint",
      build: "build",
    });
  });

  it("returns an empty catalog when a kind's script is missing", () => {
    const ws = makeWorkspace({ scripts: { test: "vitest run" } });
    const catalog = detectScripts(ws.info);
    expect(catalog.mapping.test).toBe("test");
    expect(catalog.mapping.lint).toBeUndefined();
    expect(catalog.mapping.build).toBeUndefined();
  });

  it("ignores non-string script values and a missing scripts object", () => {
    const ws = makeWorkspace({ name: "no-scripts" });
    const catalog = detectScripts(ws.info);
    expect(catalog.scripts).toEqual({});
    expect(catalog.mapping.test).toBeUndefined();
  });
});
