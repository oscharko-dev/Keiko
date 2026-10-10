import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  policyBatches,
  runNativePolicy,
  runnerIdentity,
  validateNativeResult,
} from "../lib/code-quality-runner.mjs";
import { parsePolicyArguments } from "../check-code-quality-policy.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "keiko-policy-test-"));
  roots.push(root);
  for (const [path, body] of Object.entries(files)) writeFileSync(join(root, path), body);
  return { root, files: Object.keys(files).map((path) => ({ path })) };
}
const receipt = (filename) => ({
  filename,
  code: "keiko-coverage(program)",
  message: "keiko-program-visited-v1",
});
const result = (diagnostics, status = 0) => ({
  status,
  stderr: "",
  stdout: JSON.stringify({ diagnostics }),
});

describe("real pinned native analyzer and visitation contract (#3915)", () => {
  it("qualifies the locked MIT plugin and compiler bridge", () => {
    expect(runnerIdentity()).toMatchObject({ runner: "1.78.0", plugin: "0.1.2", bridge: "1.78.0" });
  });

  it("rejects erased type evidence, Reflect invocation and accumulator copies", () => {
    const input = fixture({
      "widen.ts":
        "const original = {id: 1}; const erased: unknown = original; const restored = erased as {id: number};",
      "apply.ts": "Reflect.apply(Math.max, null, [1, 2]);",
      "reduce.ts": "const values = [1, 2]; values.reduce((acc, item) => acc.concat(item), []);",
      "safe.ts":
        "declare const input: unknown; const parsed = input as {id: number}; const values = [1, 2]; values.reduce((acc, item) => { acc.push(item); return acc; }, []); Math.max(1, 2);",
      "empty.ts": "",
    });
    const scan = runNativePolicy(input.root, input.files);
    expect(scan.visited).toBe(5);
    const matches = scan.diagnostics.filter((entry) =>
      [
        "anti-slop/no-widen-then-assert",
        "anti-slop/no-reflect-apply",
        "anti-slop/no-reduce-accumulator-copy",
      ].includes(entry.rule),
    );
    expect(
      matches.map((entry) => entry.path).sort((left, right) => left.localeCompare(right)),
    ).toEqual(["apply.ts", "reduce.ts", "widen.ts"]);
    expect(JSON.stringify(scan)).not.toContain("original");
  });

  it("fails on real malformed syntax, suppression and plugin load failures", () => {
    const malformed = fixture({ "bad.ts": "const = ;" });
    expect(() => runNativePolicy(malformed.root, malformed.files)).toThrow();
    const disabled = fixture({
      "disabled.ts":
        "// oxlint-disable anti-slop/no-reflect-apply\nReflect.apply(Math.max, null, [1]);",
    });
    expect(() => runNativePolicy(disabled.root, disabled.files)).toThrow(
      "inline-policy-suppression",
    );
    expect(() =>
      validateNativeResult("/repo", [{ path: "a.ts" }], {
        status: 1,
        stderr: "",
        stdout: "Failed to load plugin",
      }),
    ).toThrow();
  });

  it("does not let an ESLint directive suppress the distinct native policy", () => {
    const input = fixture({
      "disabled.ts":
        "const value = 1;\n// eslint-disable-next-line\nexport const bad = Reflect.apply(Math.max, null, [value]);",
    });
    const scan = runNativePolicy(input.root, input.files);
    expect(scan.visited).toBe(1);
    expect(scan.diagnostics.some((entry) => entry.rule === "anti-slop/no-reflect-apply")).toBe(
      true,
    );
  });

  it("rejects zero, missing, duplicate, extra and unknown parser diagnostics", () => {
    const files = [{ path: "a.ts" }, { path: "b.ts" }];
    expect(
      validateNativeResult("/repo", files, result([receipt("a.ts"), receipt("b.ts")])).visited,
    ).toBe(2);
    for (const entries of [
      [],
      [receipt("a.ts")],
      [receipt("a.ts"), receipt("a.ts"), receipt("b.ts")],
      [receipt("a.ts"), receipt("b.ts"), receipt("extra.ts")],
      [receipt("a.ts"), receipt("b.ts"), { filename: "a.ts", code: "unexpected(error)" }],
    ]) {
      expect(() => validateNativeResult("/repo", files, result(entries))).toThrow();
    }
    expect(() => validateNativeResult("/repo", files, result([], 2))).toThrow();
    expect(() => validateNativeResult("/repo", [], result([]))).toThrow();
    expect(() =>
      validateNativeResult("/repo", files, { status: 0, stderr: "warning", stdout: "{}" }),
    ).toThrow();
    expect(() =>
      validateNativeResult("/repo", files, { status: 0, stderr: "", stdout: "{}" }),
    ).toThrow();
    expect(() =>
      validateNativeResult("/repo", files, result([{ ...receipt("a.ts"), filename: 12 }])),
    ).toThrow();
    expect(() =>
      validateNativeResult("/repo", files, result([{ filename: "a.ts", code: "parser/error" }])),
    ).toThrow();
  });

  it("batches Windows command lines without duplicate or missing files", () => {
    const files = [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }];
    const batches = policyBatches(files, 14);
    expect(batches).toHaveLength(2);
    expect(batches.flat()).toEqual(files);
    expect(() => policyBatches(files, 3)).toThrow();
  });

  it("rejects malformed modes, arguments and repository-wide CI claims from local scopes", () => {
    expect(parsePolicyArguments([], true)).toEqual({
      mode: "enforce",
      scope: "repository",
      json: false,
    });
    expect(parsePolicyArguments(["--mode", "census"], false).mode).toBe("census");
    for (const args of [
      ["--scope", "tests"],
      ["--mode", "census"],
      ["--mode", "wrong"],
      ["--mode"],
      ["--json", "--json"],
      ["--unknown"],
    ]) {
      expect(() => parsePolicyArguments(args, true)).toThrow();
    }
  });
});
