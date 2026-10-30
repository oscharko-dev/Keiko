import { describe, expect, it } from "vitest";
import {
  compareRegister,
  countRegisterFindings,
  parseRegister,
  pruneRegister,
  registerTotal,
  serializeRegister,
} from "../lib/code-quality-register.mjs";

const finding = (path, rule, line = 1) => ({ path, rule, line, column: 1 });
const register = (files) => countRegisterFindings(files);
const text = (files) => `${JSON.stringify({ version: 1, files }, null, 2)}\n`;

describe("code-quality register parsing (#4145)", () => {
  it("round-trips the empty register and a canonical register", () => {
    expect(parseRegister(text({})).size).toBe(0);
    const canonical = text({ "a/b.ts": { "x/one": 2, "x/two": 1 }, "c.ts": { "x/one": 1 } });
    expect(serializeRegister(parseRegister(canonical))).toBe(canonical);
  });

  it.each([
    ["non-JSON", "{"],
    ["array", "[]\n"],
    ["wrong version", `${JSON.stringify({ version: 2, files: {} }, null, 2)}\n`],
    ["extra key", `${JSON.stringify({ version: 1, files: {}, x: 1 }, null, 2)}\n`],
    ["files array", `${JSON.stringify({ version: 1, files: [] }, null, 2)}\n`],
    ["zero count", text({ "a.ts": { "x/one": 0 } })],
    ["negative count", text({ "a.ts": { "x/one": -1 } })],
    ["fractional count", text({ "a.ts": { "x/one": 1.5 } })],
    ["string count", text({ "a.ts": { "x/one": "1" } })],
    ["empty rule record", text({ "a.ts": {} })],
    ["parent segment", text({ "../a.ts": { "x/one": 1 } })],
    ["absolute path", text({ "/etc/a.ts": { "x/one": 1 } })],
    ["backslash path", text({ "a\\b.ts": { "x/one": 1 } })],
    ["dot segment", text({ "a/./b.ts": { "x/one": 1 } })],
    ["empty segment", text({ "a//b.ts": { "x/one": 1 } })],
    ["control rule", text({ "a.ts": { "x\none": 1 } })],
    ["overlong path", text({ [`${"a".repeat(600)}.ts`]: { "x/one": 1 } })],
  ])("rejects a %s register", (_name, input) => {
    expect(() => parseRegister(input)).toThrow("invalid-code-quality-register");
  });

  it("rejects unsorted or reformatted registers", () => {
    const unsorted = text({ "b.ts": { "x/one": 1 }, "a.ts": { "x/one": 1 } });
    expect(() => parseRegister(unsorted)).toThrow("noncanonical-code-quality-register");
    const compact = JSON.stringify({ version: 1, files: { "a.ts": { "x/one": 1 } } });
    expect(() => parseRegister(compact)).toThrow("noncanonical-code-quality-register");
  });

  it("accepts bracketed route folders", () => {
    const route = text({ "app/[id]/page.tsx": { "x/one": 1 } });
    expect(parseRegister(route).has("app/[id]/page.tsx")).toBe(true);
  });

  it("keeps a hostile __proto__ key an ordinary entry", () => {
    const hostile =
      '{\n  "version": 1,\n  "files": {\n    "__proto__": {\n      "x/one": 1\n    }\n  }\n}\n';
    const parsed = parseRegister(hostile);
    expect(parsed.get("__proto__")?.get("x/one")).toBe(1);
    expect(serializeRegister(parsed)).toBe(hostile);
    expect(Object.prototype).not.toHaveProperty("x/one");
  });
});

describe("code-quality register comparison (#4145)", () => {
  const scanned = new Set(["a.ts", "b.ts"]);
  const baseline = register([finding("a.ts", "x/one"), finding("a.ts", "x/one", 2)]);

  it("counts findings per path and rule", () => {
    expect(registerTotal(baseline)).toBe(2);
    expect(() => countRegisterFindings([finding("../a.ts", "x/one")])).toThrow(
      "unknown-diagnostic",
    );
  });

  it("passes an unchanged register at the boundary", () => {
    expect(
      compareRegister(
        baseline,
        register([...[1, 2].map((line) => finding("a.ts", "x/one", line))]),
        scanned,
      ),
    ).toMatchObject({
      outcome: "passed",
      before: 2,
      after: 2,
    });
    expect(compareRegister(new Map(), new Map(), new Set())).toMatchObject({ outcome: "passed" });
  });

  it("fails an increase, a new rule and a new path", () => {
    const current = register([
      finding("a.ts", "x/one"),
      finding("a.ts", "x/one", 2),
      finding("a.ts", "x/one", 3),
      finding("a.ts", "x/two"),
      finding("b.ts", "x/one"),
    ]);
    const result = compareRegister(baseline, current, scanned);
    expect(result.outcome).toBe("failed");
    expect(result.increases).toEqual([
      { path: "a.ts", rule: "x/one", before: 2, after: 3 },
      { path: "a.ts", rule: "x/two", before: 0, after: 1 },
      { path: "b.ts", rule: "x/one", before: 0, after: 1 },
    ]);
  });

  it("fails a decrease until the register is pruned", () => {
    const current = register([finding("a.ts", "x/one")]);
    const result = compareRegister(baseline, current, scanned);
    expect(result).toMatchObject({ outcome: "failed", before: 2, after: 1 });
    expect(result.decreases).toEqual([{ path: "a.ts", rule: "x/one", before: 2, after: 1 }]);
    const pruned = pruneRegister(baseline, current, scanned);
    expect(compareRegister(pruned, current, scanned).outcome).toBe("passed");
    const cleared = pruneRegister(baseline, new Map(), scanned);
    expect(serializeRegister(cleared)).toBe(text({}));
  });

  it("fails a stale entry for a path the scan no longer visits", () => {
    const result = compareRegister(baseline, new Map(), new Set(["b.ts"]));
    expect(result).toMatchObject({ outcome: "failed", stale: ["a.ts"], decreases: [] });
    expect(pruneRegister(baseline, new Map(), new Set(["b.ts"])).size).toBe(0);
  });

  it("refuses to prune when any count would rise", () => {
    const current = register([finding("a.ts", "x/one"), finding("b.ts", "x/one")]);
    expect(() => pruneRegister(baseline, current, scanned)).toThrow(
      "code-quality-register-increase",
    );
  });
});

describe("code-quality ratchet arguments (#4145)", () => {
  it("selects the ratchet for register actions and allows it in CI", async () => {
    const { parsePolicyArguments } = await import("../check-code-quality-policy.mjs");
    expect(parsePolicyArguments(["--mode", "ratchet"], true)).toMatchObject({ mode: "ratchet" });
    expect(parsePolicyArguments(["--prune-register"], false)).toMatchObject({
      mode: "ratchet",
      registerAction: "prune",
    });
    expect(parsePolicyArguments(["--initialize-register"], false)).toMatchObject({
      registerAction: "initialize",
    });
  });

  it.each([
    [["--prune-register"], true, "register-write-in-ci"],
    [["--prune-register", "--initialize-register"], false, "invalid-arguments"],
    [["--mode", "census", "--prune-register"], false, "invalid-mode"],
    [["--mode", "ratchet", "--qualify-responsibilities"], false, "invalid-mode"],
    [["--mode", "ratchet", "--scope", "ui"], false, "partial-ci-scope"],
    [["--mode", "census"], true, "partial-ci-verdict"],
  ])("rejects %j (ci=%s)", async (args, ci, reason) => {
    const { parsePolicyArguments } = await import("../check-code-quality-policy.mjs");
    expect(() => parsePolicyArguments(args, ci)).toThrow(reason);
  });
});
