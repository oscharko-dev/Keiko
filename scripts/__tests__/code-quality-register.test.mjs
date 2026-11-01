import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  compareRegister,
  countRegisterFindings,
  parseIncreases,
  parseRegister,
  pruneRegister,
  registerTotal,
  reviewRegisterRaises,
  serializeIncreases,
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

const BASE = "a".repeat(40);
const BASE_ENV = { KEIKO_CODE_QUALITY_BASE_SHA: BASE };

describe("code-quality ratchet arguments (#4145)", () => {
  it("selects the ratchet for register actions and allows it in CI", async () => {
    const { parsePolicyArguments } = await import("../check-code-quality-policy.mjs");
    expect(parsePolicyArguments(["--mode", "ratchet"], true, BASE_ENV)).toMatchObject({
      mode: "ratchet",
      registerBase: BASE,
    });
    expect(parsePolicyArguments(["--mode", "ratchet"], false, {})).not.toHaveProperty(
      "registerBase",
    );
    expect(parsePolicyArguments(["--prune-register"], false, BASE_ENV)).not.toHaveProperty(
      "registerBase",
    );
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
    expect(() => parsePolicyArguments(args, ci, BASE_ENV)).toThrow(reason);
  });

  it.each([{}, { KEIKO_CODE_QUALITY_BASE_SHA: "" }])(
    "refuses a CI comparison without a base commit (%j)",
    async (env) => {
      const { parsePolicyArguments } = await import("../check-code-quality-policy.mjs");
      expect(() => parsePolicyArguments(["--mode", "ratchet"], true, env)).toThrow(
        "missing-code-quality-base",
      );
    },
  );
});

const increase = (path, rule, from, to, overrides = {}) => ({
  path,
  rule,
  from,
  to,
  reason: "test-witness",
  issue: 3918,
  ...overrides,
});
const ledgerText = (increases) => `${JSON.stringify({ version: 1, increases }, null, 2)}\n`;

describe("code-quality reviewed increase ledger parsing (#4145)", () => {
  it("round-trips the empty ledger and a canonical ledger", () => {
    expect(parseIncreases(ledgerText([]))).toEqual([]);
    const canonical = ledgerText([
      increase("a.ts", "x/one", 0, 2, { reason: "qualified-boundary" }),
      increase("a.ts", "x/one", 2, 3, { reason: "proof-fixture", issue: 1 }),
      increase("a.ts", "x/one", 2, 3, { issue: 2 }),
      increase("b.ts", "x/one", 1, 4, { reason: "pending-boundary-migration" }),
    ]);
    expect(serializeIncreases(parseIncreases(canonical))).toBe(canonical);
  });

  it.each([
    ["non-JSON", "{"],
    ["array", "[]\n"],
    ["wrong version", `${JSON.stringify({ version: 2, increases: [] }, null, 2)}\n`],
    ["extra top-level key", `${JSON.stringify({ version: 1, increases: [], x: 1 }, null, 2)}\n`],
    ["object increases", `${JSON.stringify({ version: 1, increases: {} }, null, 2)}\n`],
    ["non-record entry", ledgerText([1])],
    [
      "missing key",
      ledgerText([{ path: "a.ts", rule: "x/one", from: 0, to: 1, reason: "test-witness" }]),
    ],
    ["extra key", ledgerText([{ ...increase("a.ts", "x/one", 0, 1), note: "x" }])],
    [
      "reordered keys",
      ledgerText([
        { rule: "x/one", path: "a.ts", from: 0, to: 1, reason: "test-witness", issue: 1 },
      ]),
    ],
    ["unsafe path", ledgerText([increase("../a.ts", "x/one", 0, 1)])],
    ["numeric path", ledgerText([increase(1, "x/one", 0, 1)])],
    ["array path", ledgerText([increase(["a.ts"], "x/one", 0, 1)])],
    ["array rule", ledgerText([increase("a.ts", ["x/one"], 0, 1)])],
    ["unsafe rule", ledgerText([increase("a.ts", "x\none", 0, 1)])],
    ["negative from", ledgerText([increase("a.ts", "x/one", -1, 1)])],
    ["fractional from", ledgerText([increase("a.ts", "x/one", 0.5, 1)])],
    ["equal from and to", ledgerText([increase("a.ts", "x/one", 2, 2)])],
    ["falling count", ledgerText([increase("a.ts", "x/one", 3, 2)])],
    ["string to", ledgerText([increase("a.ts", "x/one", 0, "1")])],
    ["unknown reason", ledgerText([increase("a.ts", "x/one", 0, 1, { reason: "convenience" })])],
    ["zero issue", ledgerText([increase("a.ts", "x/one", 0, 1, { issue: 0 })])],
    ["string issue", ledgerText([increase("a.ts", "x/one", 0, 1, { issue: "3918" })])],
    [
      "duplicate entry",
      ledgerText([increase("a.ts", "x/one", 0, 1), increase("a.ts", "x/one", 0, 1)]),
    ],
  ])("rejects a ledger with a %s", (_name, input) => {
    expect(() => parseIncreases(input)).toThrow("invalid-code-quality-register-increases");
  });

  it("rejects unsorted or reformatted ledgers", () => {
    const unsorted = ledgerText([increase("b.ts", "x/one", 0, 1), increase("a.ts", "x/one", 0, 1)]);
    expect(() => parseIncreases(unsorted)).toThrow("noncanonical-code-quality-register-increases");
    const compact = JSON.stringify({ version: 1, increases: [] });
    expect(() => parseIncreases(compact)).toThrow("noncanonical-code-quality-register-increases");
  });

  it("commits the empty ledger on dev", () => {
    const committed = readFileSync("scripts/code-quality-register-increases.json", "utf8");
    expect(parseIncreases(committed)).toEqual([]);
  });
});

describe("code-quality register prune with reviewed increases (#4145)", () => {
  const scanned = new Set(["a.ts", "b.ts"]);
  const baseline = register([finding("a.ts", "x/one"), finding("a.ts", "x/one", 2)]);
  const raised = register([
    ...[1, 2, 3].map((line) => finding("a.ts", "x/one", line)),
    finding("b.ts", "x/one"),
  ]);

  it("raises counts to exactly the `to` of matching entries", () => {
    const ledger = [increase("a.ts", "x/one", 2, 3), increase("b.ts", "x/one", 0, 1)];
    const pruned = pruneRegister(baseline, raised, scanned, ledger);
    expect(compareRegister(pruned, raised, scanned).outcome).toBe("passed");
    expect(registerTotal(pruned)).toBe(4);
  });

  it("lowers counts with or without a ledger", () => {
    const lowered = register([finding("a.ts", "x/one")]);
    expect(registerTotal(pruneRegister(baseline, lowered, scanned, []))).toBe(1);
    const unrelated = [increase("b.ts", "x/one", 0, 1)];
    expect(registerTotal(pruneRegister(baseline, lowered, scanned, unrelated))).toBe(1);
  });

  it.each([
    ["no entry", [increase("b.ts", "x/one", 0, 1)]],
    ["a count above `to`", [increase("a.ts", "x/one", 2, 3), increase("b.ts", "x/one", 0, 1)], 4],
    ["a count below `to`", [increase("a.ts", "x/one", 2, 4), increase("b.ts", "x/one", 0, 1)]],
    ["another `from`", [increase("a.ts", "x/one", 1, 3), increase("b.ts", "x/one", 0, 1)]],
    ["another rule", [increase("a.ts", "x/two", 2, 3), increase("b.ts", "x/one", 0, 1)]],
    ["another path", [increase("c.ts", "x/one", 2, 3), increase("b.ts", "x/one", 0, 1)]],
  ])("refuses a raise with %s", (_name, ledger, count = 3) => {
    const current = register([
      ...Array.from({ length: count }, (_, index) => finding("a.ts", "x/one", index + 1)),
      finding("b.ts", "x/one"),
    ]);
    expect(() => pruneRegister(baseline, current, scanned, ledger)).toThrow(
      "code-quality-register-increase",
    );
  });
});

describe("code-quality register review against the base commit (#4145)", () => {
  const base = register([finding("a.ts", "x/one"), finding("a.ts", "x/one", 2)]);
  const raised = register([
    ...[1, 2, 3].map((line) => finding("a.ts", "x/one", line)),
    finding("b.ts", "x/one"),
  ]);
  const history = [increase("old.ts", "x/one", 0, 1)];
  const reviewed = [increase("a.ts", "x/one", 2, 3), increase("b.ts", "x/one", 0, 1)];

  it("passes an unchanged register and an unchanged ledger", () => {
    expect(
      reviewRegisterRaises({
        baseRegister: base,
        register: base,
        baseIncreases: history,
        increases: history,
      }),
    ).toEqual({ raises: [], unreviewed: [], stale: [], rewritten: [], outcome: "passed" });
  });

  it("passes lowered counts without ledger entries", () => {
    const lowered = register([finding("a.ts", "x/one")]);
    expect(
      reviewRegisterRaises({
        baseRegister: base,
        register: lowered,
        baseIncreases: [],
        increases: [],
      }).outcome,
    ).toBe("passed");
  });

  it("passes each raise that one added entry names exactly", () => {
    const result = reviewRegisterRaises({
      baseRegister: base,
      register: raised,
      baseIncreases: history,
      increases: [...history, ...reviewed],
    });
    expect(result).toMatchObject({ outcome: "passed", unreviewed: [], stale: [], rewritten: [] });
    expect(result.raises).toHaveLength(2);
  });

  it("fails a raise without an added entry", () => {
    const result = reviewRegisterRaises({
      baseRegister: base,
      register: raised,
      baseIncreases: [],
      increases: [reviewed[1]],
    });
    expect(result).toMatchObject({ outcome: "failed", stale: [] });
    expect(result.unreviewed).toEqual([{ path: "a.ts", rule: "x/one", before: 2, after: 3 }]);
  });

  it("fails a raise that only a base entry names, so history cannot be reused", () => {
    const result = reviewRegisterRaises({
      baseRegister: base,
      register: raised,
      baseIncreases: reviewed,
      increases: reviewed,
    });
    expect(result.outcome).toBe("failed");
    expect(result.unreviewed).toHaveLength(2);
  });

  it("fails an added entry that matches no raise as stale", () => {
    const extra = increase("a.ts", "x/one", 3, 4);
    const result = reviewRegisterRaises({
      baseRegister: base,
      register: raised,
      baseIncreases: [],
      increases: [...reviewed, extra],
    });
    expect(result).toMatchObject({ outcome: "failed", unreviewed: [], stale: [extra] });
  });

  it("fails a removed or changed base entry as rewritten history", () => {
    const removed = reviewRegisterRaises({
      baseRegister: base,
      register: base,
      baseIncreases: history,
      increases: [],
    });
    expect(removed).toMatchObject({ outcome: "failed", rewritten: history });
    const changed = [{ ...history[0], reason: "proof-fixture" }];
    const result = reviewRegisterRaises({
      baseRegister: base,
      register: base,
      baseIncreases: history,
      increases: changed,
    });
    expect(result).toMatchObject({ outcome: "failed", rewritten: history, stale: changed });
  });
});

function fixtureRepository() {
  const root = mkdtempSync(join(tmpdir(), "keiko-register-review-"));
  const git = (args) =>
    execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { encoding: "utf8" },
    ).trim();
  git(["init", "--quiet"]);
  mkdirSync(join(root, "scripts"));
  const commit = (files, message) => {
    for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
    git(["add", "-A"]);
    git(["commit", "--quiet", "--allow-empty", "-m", message]);
    return git(["rev-parse", "HEAD"]);
  };
  return { root, commit };
}

describe("code-quality register review CLI base (#4145)", () => {
  const registerFile = "scripts/code-quality-register.json";
  const ledgerFile = "scripts/code-quality-register-increases.json";
  const baseRegister = text({ "a.ts": { "x/one": 2 } });
  const head = parseRegister(text({ "a.ts": { "x/one": 3 } }));
  const entry = increase("a.ts", "x/one", 2, 3);

  it("reviews against the base commit's register and ledger", async () => {
    const { reviewRegisterAgainstBase } = await import("../check-code-quality-policy.mjs");
    const { root, commit } = fixtureRepository();
    try {
      const base = commit({ [registerFile]: baseRegister, [ledgerFile]: ledgerText([]) }, "base");
      expect(reviewRegisterAgainstBase(root, base, head, [entry])).toMatchObject({
        status: "compared",
        base,
        outcome: "passed",
      });
      expect(reviewRegisterAgainstBase(root, base, head, [])).toMatchObject({
        status: "compared",
        outcome: "failed",
        unreviewed: [{ path: "a.ts", rule: "x/one", before: 2, after: 3 }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats a missing base ledger as empty and an all-zero base as HEAD's first parent", async () => {
    const { reviewRegisterAgainstBase } = await import("../check-code-quality-policy.mjs");
    const { root, commit } = fixtureRepository();
    try {
      const base = commit({ [registerFile]: baseRegister }, "base");
      commit({ [registerFile]: text({ "a.ts": { "x/one": 3 } }) }, "head");
      expect(reviewRegisterAgainstBase(root, "0".repeat(40), head, [entry])).toMatchObject({
        status: "compared",
        base,
        outcome: "passed",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes only an empty ledger when the base predates the register", async () => {
    const { reviewRegisterAgainstBase } = await import("../check-code-quality-policy.mjs");
    const { root, commit } = fixtureRepository();
    try {
      const base = commit({}, "before the register");
      expect(reviewRegisterAgainstBase(root, base, head, [])).toMatchObject({
        status: "base-register-absent",
        outcome: "passed",
      });
      expect(reviewRegisterAgainstBase(root, base, head, [entry])).toMatchObject({
        status: "base-register-absent",
        outcome: "failed",
        stale: [entry],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["an abbreviated id", "abc1234"],
    ["a ref name", "HEAD"],
    ["an option", "--output=x"],
    ["an unknown commit", "b".repeat(40)],
  ])("refuses %s as the base", async (_name, base) => {
    const { reviewRegisterAgainstBase } = await import("../check-code-quality-policy.mjs");
    const { root, commit } = fixtureRepository();
    try {
      commit({ [registerFile]: baseRegister }, "base");
      expect(() => reviewRegisterAgainstBase(root, base, head, [])).toThrow(
        "invalid-code-quality-base",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on a malformed base ledger", async () => {
    const { reviewRegisterAgainstBase } = await import("../check-code-quality-policy.mjs");
    const { root, commit } = fixtureRepository();
    try {
      const base = commit({ [registerFile]: baseRegister, [ledgerFile]: "{}\n" }, "base");
      expect(() => reviewRegisterAgainstBase(root, base, head, [])).toThrow(
        "invalid-code-quality-register-increases",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const RATCHET_COMMAND = "npm run check:code-quality-policy -- --mode ratchet";

const RATCHET_BASE = "${{ github.event.pull_request.base.sha || github.event.before }}";

function ratchetStepDefects(step) {
  const defects = [];
  if (step.run !== RATCHET_COMMAND) defects.push("partial");
  if (step.env?.KEIKO_CODE_QUALITY_BASE_SHA !== RATCHET_BASE) defects.push("unbased");
  if (Object.hasOwn(step, "if")) defects.push("conditional");
  if (Object.hasOwn(step, "continue-on-error")) defects.push("continued");
  return defects;
}

function ratchetOrderDefects(steps, step) {
  const runs = steps.map((entry) => entry.run);
  const prerequisites = ["npm run typecheck", "npm run lint"].map((run) => runs.indexOf(run));
  const position = steps.indexOf(step);
  return prerequisites.every((index) => index >= 0 && index < position) ? [] : ["reordered"];
}

function ratchetWiringDefects(workflow) {
  const defects = workflow.jobs.ci.needs.includes("core-quality") ? [] : ["not-required"];
  const steps = workflow.jobs["core-quality"].steps;
  const ratchets = steps.filter((step) => step.run?.includes("check:code-quality-policy"));
  if (ratchets.length !== 1) return [...defects, "missing-or-duplicated"];
  return [
    ...defects,
    ...ratchetStepDefects(ratchets[0]),
    ...ratchetOrderDefects(steps, ratchets[0]),
  ];
}

// Replaces the epic's qualification-workflow pins on dev (#4145): the required `ci` context must
// run the full-repository ratchet unconditionally, after the build and lint it depends on.
describe("code-quality ratchet CI wiring (#4145)", () => {
  const workflow = () => parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const ratchetStep = (copy) =>
    copy.jobs["core-quality"].steps.find((step) => step.run === RATCHET_COMMAND);

  it("runs the ratchet once, unconditionally, after typecheck and lint in a required job", () => {
    expect(ratchetWiringDefects(workflow())).toEqual([]);
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    expect(manifest.scripts["check:code-quality-policy"]).toBe(
      "node scripts/check-code-quality-policy.mjs",
    );
  });

  it.each([
    [
      "missing-or-duplicated",
      (copy) => {
        const steps = copy.jobs["core-quality"].steps;
        steps.splice(steps.indexOf(ratchetStep(copy)), 1);
      },
    ],
    ["conditional", (copy) => (ratchetStep(copy).if = "${{ false }}")],
    ["continued", (copy) => (ratchetStep(copy)["continue-on-error"] = true)],
    ["partial", (copy) => (ratchetStep(copy).run = `${RATCHET_COMMAND} --scope contracts`)],
    ["unbased", (copy) => delete ratchetStep(copy).env.KEIKO_CODE_QUALITY_BASE_SHA],
    [
      "unbased",
      (copy) => (ratchetStep(copy).env.KEIKO_CODE_QUALITY_BASE_SHA = "${{ github.event.before }}"),
    ],
    [
      "reordered",
      (copy) => {
        const steps = copy.jobs["core-quality"].steps;
        steps.unshift(...steps.splice(steps.indexOf(ratchetStep(copy)), 1));
      },
    ],
    [
      "not-required",
      (copy) => (copy.jobs.ci.needs = copy.jobs.ci.needs.filter((id) => id !== "core-quality")),
    ],
  ])("refuses a %s ratchet mutation", (defect, mutate) => {
    const copy = workflow();
    mutate(copy);
    expect(ratchetWiringDefects(copy)).toContain(defect);
  });
});
