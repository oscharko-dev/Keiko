import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GUARDED_APIS,
  main,
  parseDeclaredFloors,
  transpileFloorViolations,
  violationsFor,
} from "../check-browser-baseline.mjs";
import { TARGETS as TRANSPILE_TARGETS } from "../transpile-ui-static-js.mjs";

// Review finding (F1): parseDeclaredFloors kept only the LAST floor per engine — for
// ["chrome >= 100", "chrome >= 111"] it checked only Chrome 111, even though Browserslist itself
// resolves and unions every query in the array, so Chrome 100 stays a real declared-supported
// target. A guarded API needing Chrome 103-110 would then pass this gate while remaining
// unreachable on a browser Browserslist still declares supported. This pins the fail-closed
// replacement: a duplicate engine is a gate FAILURE, matching every other unparsable-declaration
// path in this file, never a silent last-write-wins overwrite.
describe("parseDeclaredFloors", () => {
  it("keeps one floor per engine for a well-formed declaration", () => {
    expect(parseDeclaredFloors(["chrome >= 111", "firefox >= 100", "safari >= 16.4"])).toEqual(
      new Map([
        ["chrome", 111],
        ["firefox", 100],
        ["safari", 16.4],
      ]),
    );
  });

  it("fails closed on a duplicate engine instead of silently keeping only the last floor", () => {
    const exitCode = process.exitCode;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = parseDeclaredFloors(["chrome >= 100", "chrome >= 111"]);
      expect(result).toBeUndefined();
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("chrome more than once (100 and 111)"),
      );
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = exitCode;
      error.mockRestore();
    }
  });

  it("fails closed on an unparsable browserslist entry", () => {
    const exitCode = process.exitCode;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(parseDeclaredFloors(["chrome >= 111", "not a floor"])).toBeUndefined();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('"not a floor"'));
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = exitCode;
      error.mockRestore();
    }
  });

  it("accepts a fractional floor, which Safari versions actually use", () => {
    expect(parseDeclaredFloors(["safari >= 16.4"])).toEqual(new Map([["safari", 16.4]]));
  });

  it("returns an empty map for an empty query list rather than failing", () => {
    expect(parseDeclaredFloors([])).toEqual(new Map());
  });
});

// The API check itself. `violationsFor` decides whether a USED api is reachable on every declared
// floor, and its silence is what makes the gate pass — so each branch is pinned rather than
// exercised only through the end-to-end run, where one missing report is invisible.
describe("violationsFor", () => {
  const api = { name: "Test.api", pattern: /x/u, minimum: { chrome: 116, firefox: 124 } };

  it("reports one violation per engine that sits below the API's minimum", () => {
    const found = violationsFor(
      api,
      ["a.ts", "b.ts"],
      new Map([
        ["chrome", 111],
        ["firefox", 111],
      ]),
    );
    expect(found).toHaveLength(2);
    expect(found[0]).toContain("chrome >= 116");
    // The count is a FILE count and must say so — printing it as "call site(s)" is what made the
    // original commit message quote three wrong numbers.
    expect(found[0]).toContain("2 file(s)");
  });

  it("stays silent when every declared floor already satisfies the API", () => {
    expect(
      violationsFor(
        api,
        ["a.ts"],
        new Map([
          ["chrome", 120],
          ["firefox", 130],
        ]),
      ),
    ).toEqual([]);
  });

  it("ignores an engine the declaration does not name", () => {
    // Not this gate's business: a floor that is absent cannot be violated, and inventing one would
    // fail a declaration that deliberately does not target that engine.
    expect(violationsFor(api, ["a.ts"], new Map([["chrome", 120]]))).toEqual([]);
  });

  it("treats an exactly-equal floor as satisfied, not as a violation", () => {
    expect(violationsFor(api, ["a.ts"], new Map([["chrome", 116]]))).toEqual([]);
  });
});

// The transpile-floor direction check. Only ONE direction is a defect, so both are pinned: a floor
// below the declaration is deliberate slack, a floor above it emits syntax a declared-supported
// browser cannot parse.
describe("transpileFloorViolations", () => {
  it("accepts a transpile floor below the declared floor (deliberate slack)", () => {
    expect(transpileFloorViolations(new Map([["chrome", 111]]))).toEqual([]);
  });

  it("reports a transpile floor ABOVE the declared floor", () => {
    const found = transpileFloorViolations(new Map([["chrome", 60]]));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("is ABOVE the declared browserslist floor");
  });

  it("ignores an engine the declaration does not name", () => {
    expect(transpileFloorViolations(new Map())).toEqual([]);
  });

  // Guards the real pairing rather than a copy of it: the shipped TARGETS must sit at or below the
  // shipped browserslist, so this fails if either file moves past the other.
  it("passes for the SHIPPED transpile targets against the SHIPPED declaration", () => {
    const declared = parseDeclaredFloors(
      JSON.parse(readFileSync("packages/keiko-ui/package.json", "utf8")).browserslist,
    );
    expect(declared).toBeDefined();
    expect(transpileFloorViolations(declared)).toEqual([]);
    // And the targets it checked are the transpiler's real ones, not a restatement.
    expect(Object.keys(TRANSPILE_TARGETS).length).toBeGreaterThan(0);
  });
});

describe("GUARDED_APIS", () => {
  it("carries a name, a pattern and at least one engine minimum for every entry", () => {
    expect(GUARDED_APIS.length).toBeGreaterThan(0);
    for (const api of GUARDED_APIS) {
      expect(typeof api.name).toBe("string");
      expect(api.pattern).toBeInstanceOf(RegExp);
      expect(Object.keys(api.minimum).length).toBeGreaterThan(0);
    }
  });

  it("matches the API text it guards, so a pattern cannot silently stop matching", () => {
    const samples = {
      "Array.prototype.at": "items.at(-1)",
      "crypto.randomUUID": "crypto.randomUUID()",
      "AbortSignal.timeout": "AbortSignal.timeout(15)",
      "AbortSignal.any": "AbortSignal.any([a, b])",
      structuredClone: "structuredClone(value)",
      "Object.hasOwn": "Object.hasOwn(o, k)",
    };
    for (const [name, sample] of Object.entries(samples)) {
      const api = GUARDED_APIS.find((entry) => entry.name === name);
      expect(api, `${name} is no longer guarded`).toBeDefined();
      expect(api.pattern.test(sample), `${name} pattern no longer matches ${sample}`).toBe(true);
    }
  });
});

// `main()` is the orchestration: which check runs, in what order, and what stops the run. Left
// untested it is the largest untested block in the gate, and a wrong branch there shows up as a
// confusing PASS rather than a failure — the exact way a gate quietly stops guarding.
describe("main", () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  });

  function fixture({ browserslist, source }) {
    const root = mkdtempSync(join(tmpdir(), "keiko-browser-baseline-"));
    roots.push(root);
    const uiPackage = join(root, "package.json");
    writeFileSync(uiPackage, JSON.stringify({ browserslist }), "utf8");
    const src = join(root, "src");
    mkdirSync(src, { recursive: true });
    if (source !== undefined) writeFileSync(join(src, "app.ts"), source, "utf8");
    return { uiPackage, sourceRoots: [src] };
  }

  function run(args) {
    const previous = process.exitCode;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.exitCode = undefined;
    try {
      main(args);
      return {
        exitCode: process.exitCode,
        errors: error.mock.calls.map((call) => String(call[0])),
        logs: log.mock.calls.map((call) => String(call[0])),
      };
    } finally {
      process.exitCode = previous;
      error.mockRestore();
      log.mockRestore();
    }
  }

  it("passes when every used API is reachable on the declared floors", () => {
    const result = run(
      fixture({ browserslist: ["chrome >= 120"], source: "const last = items.at(-1);\n" }),
    );
    expect(result.exitCode).toBeUndefined();
    expect(result.logs.join("\n")).toContain("browser-baseline: PASS");
  });

  it("fails when a used API needs a higher floor than the declaration", () => {
    const result = run(
      fixture({ browserslist: ["chrome >= 80"], source: "const last = items.at(-1);\n" }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.errors.join("\n")).toContain("Array.prototype.at needs chrome >= 92");
  });

  it("ignores an API the sources never call", () => {
    const result = run(
      fixture({ browserslist: ["chrome >= 80"], source: "export const value = 1;\n" }),
    );
    expect(result.exitCode).toBeUndefined();
  });

  it("fails closed when the declaration is unreadable", () => {
    const result = run({ uiPackage: join(tmpdir(), "keiko-absent-package.json"), sourceRoots: [] });
    expect(result.exitCode).toBe(1);
    expect(result.errors.join("\n")).toContain("could not be read");
  });

  it("fails closed on an empty browserslist rather than passing vacuously", () => {
    const result = run(fixture({ browserslist: [], source: "export const v = 1;\n" }));
    expect(result.exitCode).toBe(1);
    expect(result.errors.join("\n")).toContain("declares no browserslist floors");
  });

  // A scan over zero files would report PASS while checking nothing at all.
  it("fails closed when no UI sources are found", () => {
    const result = run(fixture({ browserslist: ["chrome >= 120"] }));
    expect(result.exitCode).toBe(1);
    expect(result.errors.join("\n")).toContain("would pass vacuously");
  });

  // The transpile-floor check must run BEFORE the API scan and stop the run: a bundle that a
  // declared-supported browser cannot parse makes the API question irrelevant.
  it("stops at the transpile-floor check without reporting API violations", () => {
    const result = run(
      fixture({ browserslist: ["chrome >= 60"], source: "const last = items.at(-1);\n" }),
    );
    expect(result.exitCode).toBe(1);
    const errors = result.errors.join("\n");
    expect(errors).toContain("is ABOVE the declared browserslist floor");
    expect(errors).not.toContain("Array.prototype.at needs");
  });
});
