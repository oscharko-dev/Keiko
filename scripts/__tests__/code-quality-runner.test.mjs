import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { resolveGitExecutable } from "../check-dependency-hygiene.mjs";
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
// Built at runtime so this suite never holds the directive text the runner rejects (REVIEW-3918-041).
const DISABLE = ["oxlint", "disable"].join("-");
const APPLY = "Reflect.apply(Math.max, null, [1])";
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
      "disabled.ts": `// ${DISABLE} anti-slop/no-reflect-apply\n${APPLY};`,
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
    ).toThrow(SyntaxError);
  });

  // A bare token scanner reads a quote after JSX text, a regular expression or a template tail as
  // an unterminated string to the end of the line, which hid a directive there (REVIEW-3918-041).
  it.each([
    [
      "JSX text with an apostrophe",
      "view.tsx",
      `export const view = (\n  <div>\n    <p>Don't</p> {/* ${DISABLE}-next-line anti-slop/no-reflect-apply */}\n    {${APPLY}}\n  </div>\n);\n`,
    ],
    [
      "a regular expression with a quote",
      "regex.ts",
      `export const bad = [/"/u, ${APPLY}]; // ${DISABLE}-line anti-slop/no-reflect-apply\n`,
    ],
    [
      "a block comment after a regular expression with a quote",
      "block.ts",
      `export const quote = /'/u; /* ${DISABLE} */\nexport const bad = ${APPLY};\n`,
    ],
    [
      "a template tail with a quote",
      "template.ts",
      `export const bad = [\`\${1}'\`, ${APPLY}]; // ${DISABLE}-line anti-slop/no-reflect-apply\n`,
    ],
  ])("rejects a directive after %s on the same line", (_shape, path, body) => {
    const input = fixture({ [path]: body });
    expect(() => runNativePolicy(input.root, input.files)).toThrow("inline-policy-suppression");
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

  it("accepts exactly one receipt per file", () => {
    const files = [{ path: "a.ts" }, { path: "b.ts" }];
    expect(
      validateNativeResult("/repo", files, result([receipt("a.ts"), receipt("b.ts")])).visited,
    ).toBe(2);
  });

  // Each case names the guard that must refuse it, so deleting a guard turns its case red
  // (REVIEW-3918-042).
  const labelled = (filename, code) => ({
    filename,
    code,
    labels: [{ span: { line: 1, column: 1 } }],
  });
  it.each([
    ["no receipt", [], 0, "incomplete-parser-visitation"],
    ["a missing receipt", [receipt("a.ts")], 0, "incomplete-parser-visitation"],
    [
      "a duplicate receipt",
      [receipt("a.ts"), receipt("a.ts"), receipt("b.ts")],
      0,
      "incomplete-parser-visitation",
    ],
    [
      "a receipt for an unscanned file",
      [receipt("a.ts"), receipt("b.ts"), receipt("extra.ts")],
      0,
      "unknown-diagnostic",
    ],
    [
      "a diagnostic without a label",
      [receipt("a.ts"), receipt("b.ts"), { filename: "a.ts", code: "unexpected(error)" }],
      1,
      "unknown-diagnostic",
    ],
    [
      "a labelled diagnostic of a rule outside the policy",
      [receipt("a.ts"), receipt("b.ts"), labelled("a.ts", "eslint(no-debugger)")],
      1,
      "unknown-diagnostic",
    ],
    [
      "a diagnostic code without a plugin",
      [receipt("a.ts"), receipt("b.ts"), labelled("a.ts", "parser/error")],
      1,
      "unknown-diagnostic",
    ],
    ["a non-string filename", [{ ...receipt("a.ts"), filename: 12 }], 0, "unknown-diagnostic"],
    ["an unexpected exit status", [], 2, "runner-execution-failed"],
    [
      "a policy finding with exit status 0",
      [receipt("a.ts"), receipt("b.ts"), labelled("a.ts", "anti-slop(no-reflect-apply)")],
      0,
      "runner-exit-mismatch",
    ],
    [
      "exit status 1 without a finding",
      [receipt("a.ts"), receipt("b.ts")],
      1,
      "runner-exit-mismatch",
    ],
  ])("rejects %s", (_case, entries, status, reason) => {
    const files = [{ path: "a.ts" }, { path: "b.ts" }];
    expect(() => validateNativeResult("/repo", files, result(entries, status))).toThrow(reason);
  });

  it("rejects an empty scan, standard error output and a report without diagnostics", () => {
    const files = [{ path: "a.ts" }];
    expect(() => validateNativeResult("/repo", [], result([]))).toThrow(
      "incomplete-parser-visitation",
    );
    expect(() =>
      validateNativeResult("/repo", files, { status: 0, stderr: "warning", stdout: "{}" }),
    ).toThrow("runner-execution-failed");
    expect(() =>
      validateNativeResult("/repo", files, { status: 0, stderr: "", stdout: "{}" }),
    ).toThrow("invalid-runner-report");
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

const AUTHORED_DECLARATIONS = [
  "packages/keiko-editor/src/monaco/standalone-enums.d.ts",
  "packages/keiko-ui/src/types/style-evidence-modules.d.ts",
];

describe("hand-authored declaration parser membership (#3918)", () => {
  it("requires real Program receipts for both actual authored declaration sources", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const scan = runNativePolicy(
      root,
      AUTHORED_DECLARATIONS.map((path) => ({ path })),
    );
    expect(scan.visited).toBe(2);
    expect(scan.batches).toBe(1);
    expect(scan.configSha256).toMatch(/^[a-f0-9]{64}$/u);
  }, 120_000);

  it.each([
    [AUTHORED_DECLARATIONS[0], 1],
    [AUTHORED_DECLARATIONS[1], 1],
    ["packages/keiko-editor/src/monaco/generated-enums.d.ts", 0],
    ["packages/keiko-ui/src/types/style-evidence.generated.d.ts", 0],
  ])("keeps the exact Git ignore disposition for %s", (path, status) => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const result = spawnSync(
      resolveGitExecutable(),
      ["check-ignore", "--no-index", "--quiet", "--", path],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
    expect(result.status).toBe(status);
  });
});
