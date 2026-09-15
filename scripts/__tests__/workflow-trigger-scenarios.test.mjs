import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  carriesExplicitStatusFunction,
  hasIfCondition,
  impliedSuccessTraps,
  needsOf,
  skippableJobIds,
} from "../lib/workflow-trigger-scenarios.mjs";

const repoRoot = new URL("../../", import.meta.url);
const workflowsDir = fileURLToPath(new URL(".github/workflows/", repoRoot));

function loadWorkflow(name) {
  return parse(readFileSync(join(workflowsDir, name), "utf8"));
}

describe("carriesExplicitStatusFunction", () => {
  it.each([
    ["success()", true],
    ["failure()", true],
    ["always()", true],
    ["cancelled()", true],
    ["!cancelled() && needs.readiness.outputs.ready == 'true'", true],
    ["github.event_name == 'push'", false],
    ["", false],
    [undefined, false],
    [null, false],
    [42, false],
  ])("recognises %j as %s", (expr, expected) => {
    expect(carriesExplicitStatusFunction(expr)).toBe(expected);
  });
});

describe("needsOf", () => {
  it("normalises a scalar need to a one-element list", () => {
    expect(needsOf({ needs: "one" })).toStrictEqual(["one"]);
  });

  it("keeps a sequence of needs as a filtered list of strings", () => {
    expect(needsOf({ needs: ["one", "two"] })).toStrictEqual(["one", "two"]);
  });

  it("strips non-string entries from a needs sequence", () => {
    expect(needsOf({ needs: ["one", 42, null, "two"] })).toStrictEqual(["one", "two"]);
  });

  it("returns an empty array when needs is absent or invalid", () => {
    expect(needsOf({})).toStrictEqual([]);
    expect(needsOf(undefined)).toStrictEqual([]);
    expect(needsOf({ needs: {} })).toStrictEqual([]);
  });
});

describe("hasIfCondition", () => {
  it.each([
    [{ if: "github.event_name == 'push'" }, true],
    [{ if: "success()" }, true],
    [{ if: "" }, false],
    [{ if: "   " }, false],
    [{}, false],
    [{ if: 42 }, false],
    [undefined, false],
  ])("classifies %j as %s", (job, expected) => {
    expect(hasIfCondition(job)).toBe(expected);
  });
});

describe("skippableJobIds", () => {
  it("marks a job with an `if:` as skippable", () => {
    const workflow = {
      jobs: {
        gate: { if: "github.event_name == 'push'" },
        alwaysOn: {},
      },
    };
    expect(skippableJobIds(workflow)).toStrictEqual(new Set(["gate"]));
  });

  it("marks a job whose need is skippable as transitively skippable", () => {
    const workflow = {
      jobs: {
        gate: { if: "github.event_name == 'push'" },
        assembler: { needs: "gate" },
        publisher: { needs: ["assembler"] },
      },
    };
    expect(skippableJobIds(workflow)).toStrictEqual(new Set(["gate", "assembler", "publisher"]));
  });

  it("does not mark a job whose needs never touch a skippable one", () => {
    const workflow = {
      jobs: {
        build: {},
        publish: { needs: ["build"] },
      },
    };
    expect(skippableJobIds(workflow)).toStrictEqual(new Set());
  });
});

describe("impliedSuccessTraps", () => {
  it("reports a downstream job that has no explicit status function", () => {
    // The v1.0.0 tag-build shape: rehearsal-readiness is skipped on a tag push, and assembler
    // "needs: rehearsal-readiness" without an if — GitHub's implicit success() then made the
    // whole chain skip silently while the run concluded success (incident-register row 10).
    const workflow = {
      jobs: {
        readiness: { if: "github.event_name == 'push' && github.ref == 'refs/heads/dev'" },
        assembler: { needs: "readiness" },
        publish: { needs: "assembler" },
      },
    };
    const traps = impliedSuccessTraps(workflow);
    expect(traps.map((t) => t.jobId)).toStrictEqual(["assembler", "publish"]);
  });

  it("accepts a downstream job that carries an explicit status function", () => {
    const workflow = {
      jobs: {
        readiness: { if: "github.event_name == 'push' && github.ref == 'refs/heads/dev'" },
        assembler: {
          needs: "readiness",
          if: "!cancelled() && needs.readiness.outputs.ready == 'true'",
        },
      },
    };
    expect(impliedSuccessTraps(workflow)).toStrictEqual([]);
  });

  it("returns nothing when no need is skippable", () => {
    const workflow = { jobs: { a: {}, b: { needs: "a" }, c: { needs: "b" } } };
    expect(impliedSuccessTraps(workflow)).toStrictEqual([]);
  });
});

describe("release workflow trigger scenarios (regression pin)", () => {
  // Every release workflow whose job graph a tag build must execute cleanly. A trap here is the
  // v1.0.0 class of failure: a job with `needs:` on a skippable job but no `if:` with an explicit
  // status function is silently skipped when the need is skipped, and the run still concludes
  // success. The list is exhaustive rather than by suffix so a new release workflow surfaces here
  // as a missing check, not a silently-covered one.
  const RELEASE_WORKFLOWS = [
    "release.yml",
    "release-candidate.yml",
    "release-alignment.yml",
    "portable-assets.yml",
    "main-promotion.yml",
  ];

  it("release workflow list stays in sync with .github/workflows/", () => {
    const present = readdirSync(workflowsDir)
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .sort();
    for (const wf of RELEASE_WORKFLOWS) {
      expect(present).toContain(wf);
    }
  });

  it.each(RELEASE_WORKFLOWS)(
    "%s carries no implicit-success trap in its job graph",
    (workflowFile) => {
      const workflow = loadWorkflow(workflowFile);
      const traps = impliedSuccessTraps(workflow);
      if (traps.length > 0) {
        const detail = traps
          .map(
            (t) =>
              `  - ${t.jobId} needs [${t.dependsOnSkippable.join(", ")}] but has no explicit status function`,
          )
          .join("\n");
        throw new Error(
          `${workflowFile} has ${String(traps.length)} implicit-success trap(s) — every job whose need can be skipped by an if-guard must itself declare success()/failure()/always()/cancelled() so a skipped need does not silently skip the dependent job (incident-register row 10, Epic #3495):\n${detail}`,
        );
      }
    },
  );
});
