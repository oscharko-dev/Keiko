// Cause classification, measured assertions, cascade tracking and the explicit grading rules (#4327).
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("../testing/jira-chat-lab/api-qualification-runtime.mjs", () => ({
  dispatchQualification: dispatch,
  qualificationWitness: vi.fn(),
}));
vi.mock("../testing/jira-chat-lab/chat-read.mjs", () => ({
  withModelFreeJira: vi.fn(),
  prepareModelFreeChat: vi.fn(),
}));
import assert, {
  measuredAssertionCount,
  measuredNativeReadPaths,
  resetAssertionCount,
} from "../testing/jira-chat-lab/api-qualification-assert.mjs";
import {
  certainEffect,
  orderByDependencies,
  recordLeftoverState,
  runQualificationCase,
  unknownAfterEffect,
} from "../testing/jira-chat-lab/api-qualification.mjs";
import {
  annotateCause,
  causeSummary,
  describeFailure,
  jiraClass,
  markNotAttempted,
  suspectSummary,
} from "../testing/jira-chat-lab/api-qualification-cause.mjs";
import { classifyQualification } from "../testing/jira-chat-lab/api-qualification-evidence.mjs";
import {
  NativeReadError,
  read,
  readRecord,
} from "../testing/jira-chat-lab/api-qualification-read.mjs";
import { nonClusteredAbsence } from "../testing/jira-chat-lab/api-qualification-cases.mjs";
import { API_QUALIFICATION_WORKFLOW_CASES } from "../testing/jira-chat-lab/api-qualification-workflow-cases.mjs";
import { DEFAULT_LAB_CONNECTION } from "../testing/jira-chat-lab/lab-client.mjs";

const directories = [];
afterEach(() => {
  directories.forEach((directory) => rmSync(directory, { recursive: true, force: true }));
  directories.length = 0;
  vi.resetAllMocks();
  vi.restoreAllMocks();
});
const directory = () => {
  const result = mkdtempSync(join(tmpdir(), "keiko-ac7-causes-"));
  directories.push(result);
  return result;
};
const primary = { tool: "jira.projects", identity: "GET /rest/api/2/project" };
const report = {
  runId: "synthetic-run",
  sourceRevision: "a".repeat(40),
  release: "10.3.26",
  imageDigest: "b".repeat(64),
  file: "qualification-synthetic.json",
};
const binding = (identity = primary.identity) => ({ identity, contractDigest: "c".repeat(64) });
function attempt({ identity = primary.identity, outcome = "succeeded", reason, responses } = {}) {
  return {
    binding: binding(identity),
    mutation: false,
    dispatch: {
      kind: "settled",
      result: {
        status: outcome === "succeeded" ? "completed" : "failed",
        data: { operationBinding: binding(identity), outcome, ...(reason ? { reason } : {}) },
      },
      receipt: { status: "completed", budgetDisposition: "committed", effectStarted: true },
    },
    witness: { blocked: 0, responses: responses ?? [{ status: 200, truncated: false }] },
  };
}
const witnessFor = (snapshot = { blocked: 0, responses: [] }, started = 0) => ({
  arm: vi.fn(),
  snapshot: () => snapshot,
  effectsStarted: () => started,
});
const specification = (extra = {}) => ({
  ...primary,
  arguments: () => ({}),
  readback: async () => {
    assert.ok(true);
    return { matched: true, assertionCount: 1 };
  },
  ...extra,
});
const run = (spec, context = {}, snapshot, started = 0) =>
  runQualificationCase(context, {}, spec, {}, witnessFor(snapshot, started), directory(), report);

describe("measured assertions", () => {
  it("counts only assertions that held, including async ones", async () => {
    resetAssertionCount();
    assert.equal(1, 1);
    assert.ok(true);
    expect(() => assert.equal(1, 2)).toThrow(assert.AssertionError);
    await assert.rejects(async () => Promise.reject(new Error("expected")));
    expect(measuredAssertionCount()).toBe(3);
    resetAssertionCount();
    expect(measuredAssertionCount()).toBe(0);
  });
});

describe("measured assertions of shared transport", () => {
  it("does not count the native read helper's own status check as a recipe assertion", async () => {
    const labDirectory = directory();
    mkdirSync(join(labDirectory, "secrets"));
    writeFileSync(join(labDirectory, "secrets/admin-password"), "synthetic-admin", { mode: 0o600 });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new globalThis.Response(JSON.stringify({ id: "5" }), { status: 200 }),
    );
    const context = {
      session: { ...DEFAULT_LAB_CONNECTION, directory: labDirectory },
      actor: "admin",
    };
    resetAssertionCount();
    await read(context, "/rest/api/2/issue/10001");
    await readRecord(context, "5", "/rest/api/2/issue/10001");
    expect(measuredAssertionCount()).toBe(0);
    expect(measuredNativeReadPaths()).toEqual(["/rest/api/2/issue/10001"]);
    dispatch.mockResolvedValue(attempt());
    const evidence = await run(
      specification({
        readback: async () => {
          await read(context, "/rest/api/2/issue/10001");
          return { matched: true, assertionCount: 5 };
        },
      }),
    );
    expect(evidence.runtimeAvailability).toBe("unknown");
    expect(evidence.readback.measuredAssertionCount).toBe(0);
  });
});

describe("driver evidence", () => {
  it("grades a readback that asserted, and refuses one that only declared a count", async () => {
    dispatch.mockResolvedValue(attempt());
    const graded = await run(specification());
    expect(graded.runtimeAvailability).toBe("executable");
    expect(graded.readback.measuredAssertionCount).toBe(1);
    expect(graded.cause).toBeUndefined();
    const vacuous = await run(
      specification({ readback: async () => ({ matched: true, assertionCount: 9 }) }),
    );
    expect(vacuous.runtimeAvailability).toBe("unknown");
    expect(vacuous.readback.measuredAssertionCount).toBe(0);
    expect(vacuous.cause).toBe("undetermined");
  });
  it("names a pre-dispatch product refusal instead of a readback mismatch", async () => {
    const readback = vi.fn();
    dispatch.mockResolvedValue(
      attempt({ outcome: "rejected", reason: "invalid-arguments", responses: [] }),
    );
    const evidence = await run(specification({ readback }));
    expect(evidence.failure).toBe("product-refused");
    expect(evidence.cause).toBe("product");
    expect(evidence.product).toEqual({ outcome: "rejected", reason: "invalid-arguments" });
    expect(readback).not.toHaveBeenCalled();
  });
  it("persists safe detail for a failed dispatch and classifies a recipe fault as lab", async () => {
    dispatch.mockRejectedValue(new TypeError("argument builder threw a private value"));
    const output = directory();
    const evidence = await runQualificationCase(
      {},
      {},
      specification(),
      {},
      witnessFor(),
      output,
      report,
    );
    expect(evidence.failure).toBe("dispatch-failed");
    // No recipe frame and no transport signal: ambiguous, never blamed on the lab.
    expect(evidence.cause).toBe("undetermined");
    expect(evidence.detail).toMatchObject({ errorType: "TypeError", origin: "unknown" });
    expect(JSON.stringify(evidence)).not.toContain("private value");
    const stored = JSON.parse(readFileSync(join(output, `${evidence.id}.json`), "utf8"));
    expect(stored.detail.errorType).toBe("TypeError");
  });
  it("labels an oracle read refused for the lab actor as a lab fault", async () => {
    dispatch.mockResolvedValue(attempt());
    const evidence = await run(
      specification({
        readback: async () => {
          throw new NativeReadError("/rest/api/2/project", 403);
        },
      }),
    );
    expect(evidence).toMatchObject({ failure: "oracle-read-refused", cause: "lab" });
    expect(evidence.detail.nativeStatus).toBe(403);
  });
  it("records the failed auxiliary fixture as the cause of the dependent case", async () => {
    const context = {
      qualificationAuxiliaryFailure: {
        tool: "jira.create-version",
        identity: "POST /rest/api/2/version",
      },
    };
    dispatch.mockRejectedValue(new TypeError("auxiliary failed"));
    const evidence = await run(specification(), context);
    expect(evidence.cause).toBe("cascade");
    expect(evidence.blockedBy).toEqual({
      kind: "auxiliary",
      tool: "jira.create-version",
      identity: "POST /rest/api/2/version",
    });
    const prepared = await run(
      specification({
        prepare: async () => {
          throw new assert.AssertionError({ message: "precondition" });
        },
      }),
      context,
    );
    expect(prepared).toMatchObject({ failure: "prepare-precondition", cause: "cascade" });
  });
  it("keeps the unknown disposition and never lets a cause upgrade it", async () => {
    dispatch.mockResolvedValue(attempt({ responses: [{ status: 400, truncated: false }] }));
    const evidence = await run(
      specification({
        readback: async () => {
          assert.equal(1, 2);
        },
      }),
    );
    expect(evidence.runtimeAvailability).toBe("unknown");
    expect(evidence.cause).toBe("undetermined");
    expect(evidence.jira).toEqual({ statuses: [400], class: "4xx-validation" });
  });
});

describe("certain versus uncertain effects", () => {
  const settled = { phase: "settled", outcome: "succeeded", httpStatus: 204 };
  const snapshot = (status, extra = {}) => ({
    blocked: 0,
    responses: [{ status, truncated: false, ...extra }],
  });
  const unknownRow = { runtimeAvailability: "unknown" };
  it("continues after a settled native 2xx whose oracle disagreed", () => {
    expect(certainEffect(settled, snapshot(204), 1)).toBe(true);
    // A started effect without an observed response, or a response count that differs, is uncertain.
    expect(certainEffect(settled, snapshot(204), 0)).toBe(false);
    expect(certainEffect(settled, snapshot(204), 2)).toBe(false);
    const evidence = { ...unknownRow, certainEffect: true };
    expect(
      unknownAfterEffect(evidence, { effectsStarted: () => 1, snapshot: () => snapshot(204) }),
    ).toBe(false);
  });
  it.each([
    ["an unsettled journal", { phase: "dispatched", outcome: "unknown" }, 204],
    ["an unknown journal outcome", { phase: "settled", outcome: "unknown", httpStatus: 204 }, 204],
    ["a timeout", { ...settled, httpStatus: 408 }, 408],
    ["a rate limit", { ...settled, httpStatus: 429 }, 429],
    ["a server error", { ...settled, httpStatus: 503 }, 503],
    ["a status the journal does not carry", settled, 200],
  ])("stays uncertain for %s", (_name, journal, status) => {
    expect(certainEffect(journal, snapshot(status), 1)).toBe(false);
    expect(certainEffect(undefined, snapshot(204), 1)).toBe(false);
    expect(
      unknownAfterEffect(unknownRow, { effectsStarted: () => 1, snapshot: () => snapshot(status) }),
    ).toBe(true);
  });
  it("marks the certain effect on the evidence and keeps the case unknown", async () => {
    dispatch.mockResolvedValue({
      ...attempt({
        identity: "POST /rest/api/2/issue/{issueIdOrKey}/votes",
        responses: [{ status: 204, truncated: false }],
      }),
      mutation: true,
      journal: settled,
    });
    const evidence = await run(
      specification({
        identity: "POST /rest/api/2/issue/{issueIdOrKey}/votes",
        mutation: true,
        readback: async () => {
          assert.equal(1, 2);
        },
      }),
      {},
      undefined,
      1,
    );
    expect(evidence.runtimeAvailability).toBe("unknown");
    expect(evidence.certainEffect).toBe(true);
    const leftover = {};
    recordLeftoverState(leftover, evidence);
    recordLeftoverState(leftover, { id: "other" });
    expect(leftover.leftoverState).toEqual([evidence.id]);
    expect(evidence.cause).toBe("undetermined");
    expect(
      readdirSync(directories[directories.length - 1]).some((n) => n.endsWith(".pending.json")),
    ).toBe(false);
  });
});

describe("cause table", () => {
  const row = (extra) => ({ runtimeAvailability: "unknown", ...extra });
  const witness = (...statuses) => ({
    witness: { responses: statuses.map((status) => ({ status })) },
  });
  it.each([
    [row({ failure: "prepare-precondition" }), "lab"],
    [
      row({ failure: "prepare-failed", detail: { infrastructureCode: "ETIMEDOUT" } }),
      "infrastructure",
    ],
    [row({ failure: "dispatch-failed", detail: { errorType: "TimeoutError" } }), "undetermined"],
    [row({ failure: "dispatch-failed", detail: { origin: "unknown" } }), "undetermined"],
    [row({ failure: "dispatch-failed", detail: { origin: "product" } }), "product"],
    [row({ failure: "dispatch-failed", detail: { origin: "lab" } }), "lab"],
    [
      row({ failure: "readback-failed", detail: { infrastructureCode: "ECONNRESET" } }),
      "infrastructure",
    ],
    [row({ failure: "product-refused" }), "product"],
    [row({ failure: "readback-mismatch", ...witness(503) }), "undetermined"],
    [row({ failure: "readback-mismatch", ...witness(429) }), "infrastructure"],
    [row({ failure: "readback-mismatch", ...witness(400) }), "undetermined"],
    [
      row({
        failure: "readback-mismatch",
        dispatch: { result: { data: { outcome: "failed" } } },
        ...witness(200),
      }),
      "product",
    ],
    [
      row({
        failure: "readback-mismatch",
        dispatch: { result: { data: { outcome: "succeeded" } } },
        ...witness(200),
      }),
      "undetermined",
    ],
    [row({}), "undetermined"],
  ])("classifies %#", (input, cause) => {
    expect(annotateCause(input).cause).toBe(cause);
    expect(annotateCause(input).runtimeAvailability).toBe("unknown");
  });
  it("leaves graded rows alone, cascades with the blocker and counts every cause", () => {
    const graded = { runtimeAvailability: "executable" };
    expect(annotateCause(graded)).toBe(graded);
    const blocker = { kind: "case", tool: "jira.create-workflow-scheme-draft", identity: "POST x" };
    const cascade = annotateCause(row({ failure: "blocked-by-root" }), { blockedBy: blocker });
    expect(cascade).toMatchObject({ cause: "cascade", blockedBy: blocker });
    const operations = [
      cascade,
      annotateCause(row({ failure: "prepare-failed" })),
      row({}),
      { runtimeAvailability: "executable" },
      { runtimeAvailability: "deferred" },
    ];
    markNotAttempted(operations);
    expect(causeSummary(operations)).toEqual({
      product: 0,
      lab: 1,
      cascade: 1,
      infrastructure: 0,
      "not-attempted": 1,
      undetermined: 0,
    });
    expect(() => causeSummary([{ runtimeAvailability: "unknown", cause: "invented" }])).toThrow();
  });
  it("marks a product that succeeded against a disagreeing oracle as suspect, and counts it", () => {
    const mismatch = annotateCause(
      row({
        failure: "readback-mismatch",
        dispatch: { result: { data: { outcome: "succeeded" } } },
        ...witness(200),
      }),
    );
    expect(mismatch).toMatchObject({ cause: "undetermined", suspect: "product" });
    const other = annotateCause(row({ failure: "readback-mismatch", ...witness(400) }));
    expect(other.suspect).toBeUndefined();
    expect(suspectSummary([mismatch, other])).toEqual({ product: 1 });
    expect(
      annotateCause(row({ failure: "readback-mismatch", ...witness(503) }), {
        labHealthFailed: true,
      }).cause,
    ).toBe("infrastructure");
  });
  it("finds a product frame in the cause chain", () => {
    const inner = new Error("inner");
    inner.stack = "Error: inner\n    at x (/repo/packages/keiko-server/dist/atlassian/a.js:3:1)";
    const outer = new Error("outer", { cause: inner });
    outer.stack =
      "Error: outer\n    at y (/repo/scripts/testing/jira-chat-lab/api-qualification-cases.mjs:9:1)";
    expect(describeFailure(outer).origin).toBe("product");
  });
  it("classifies Jira answers into closed categories", () => {
    expect(jiraClass([])).toBe("none");
    expect(jiraClass([204])).toBe("2xx");
    expect(jiraClass([404, 404])).toBe("404");
    expect(jiraClass([200, 500])).toBe("mixed");
  });
  it("describes a failure by sites and side, never by value", () => {
    const error = new TypeError("private value");
    error.stack = [
      "TypeError: private value",
      "    at assertPrepared (/repo/packages/keiko-server/dist/atlassian/jiraChatToolTurn.js:12:3)",
      "    at read (/repo/scripts/testing/jira-chat-lab/api-qualification-cases.mjs:77:5)",
    ].join("\n");
    const detail = describeFailure(error);
    expect(detail).toMatchObject({
      origin: "product",
      productSites: ["jiraChatToolTurn.js:12"],
      sites: ["api-qualification-cases.mjs:77"],
      errorType: "TypeError",
    });
    expect(JSON.stringify(detail)).not.toContain("private value");
  });
});

describe("explicit grading rules", () => {
  const identity = "GET /rest/api/2/reindex";
  // The product answers a documented 404 with success; it fails a refused route with a reason.
  const observation = (status, readback, reason, selected = identity) => {
    const ok = reason === undefined;
    const settled = ok ? "completed" : "failed";
    return {
      identity: selected,
      binding: binding(selected),
      mutation: false,
      dispatch: {
        kind: "settled",
        result: {
          status: settled,
          data: {
            operationBinding: binding(selected),
            outcome: ok ? "succeeded" : "failed",
            ...(ok ? {} : { reason }),
          },
        },
        receipt: { status: settled, budgetDisposition: "committed", effectStarted: true },
      },
      witness: { blocked: 0, responses: [{ status, truncated: false }] },
      readback,
    };
  };
  const proof = { matched: true, assertionCount: 2, measuredAssertionCount: 2 };
  it("accepts an exact documented 404 only together with an oracle proof", () => {
    expect(
      classifyQualification(observation(404, { ...proof, documentedNativeStatuses: [404] })),
    ).toBe("executable");
    expect(classifyQualification(observation(404, proof))).toBe("unknown");
    expect(
      classifyQualification(observation(404, { ...proof, documentedNativeStatuses: [405] })),
    ).toBe("unknown");
    expect(
      classifyQualification(observation(500, { ...proof, documentedNativeStatuses: [500] })),
    ).toBe("unknown");
    expect(
      classifyQualification(observation(403, { ...proof, documentedNativeStatuses: [404] })),
    ).toBe("unknown");
    const write = {
      ...observation(404, { ...proof, documentedNativeStatuses: [404] }),
      mutation: true,
      journal: { phase: "settled", outcome: "succeeded", httpStatus: 404 },
    };
    expect(classifyQualification(write)).toBe("unknown");
  });
  const clusterNodes = "GET /rest/api/2/cluster/nodes";
  const cluster = (readback) => observation(405, readback, "unavailable", clusterNodes);
  it("grades a 405 on a non-clustered instance unavailable only with proven absence", () => {
    expect(classifyQualification(cluster({ ...proof, capabilityAbsent: true }))).toBe(
      "unavailable",
    );
    expect(classifyQualification(cluster(proof))).toBe("unknown");
  });
  it("proves non-clustered absence only for the identical independent 405 and the observed release", async () => {
    const labDirectory = directory();
    mkdirSync(join(labDirectory, "secrets"));
    writeFileSync(join(labDirectory, "secrets/admin-password"), "synthetic-admin", { mode: 0o600 });
    const context = {
      session: { ...DEFAULT_LAB_CONNECTION, directory: labDirectory },
      actor: "admin",
    };
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new globalThis.Response(
          JSON.stringify({
            version: DEFAULT_LAB_CONNECTION.jiraVersion,
            versionNumbers: DEFAULT_LAB_CONNECTION.jiraVersion.split(".").map(Number),
            deploymentType: "Data Center",
          }),
          { status: 200 },
        ),
    );
    expect(await nonClusteredAbsence(context, [200], 405)).toBeUndefined();
    expect(await nonClusteredAbsence(context, [405], 200)).toBeUndefined();
    expect(await nonClusteredAbsence(context, [], 405)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(await nonClusteredAbsence(context, [405], 405)).toEqual({
      capabilityAbsent: true,
      status: 405,
      release: DEFAULT_LAB_CONNECTION.jiraVersion,
      reason: "route-405-on-non-clustered-instance",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("dependency order and quarantine", () => {
  it("runs root causes before their dependents without reordering anything else", () => {
    const cases = [
      { tool: "a", dependsOn: ["c"] },
      { tool: "b" },
      { tool: "c" },
      { tool: "d", dependsOn: ["outside"] },
    ];
    expect(orderByDependencies(cases).map((entry) => entry.tool)).toEqual(["c", "a", "b", "d"]);
    expect(orderByDependencies(orderByDependencies(cases))).toEqual(orderByDependencies(cases));
  });
  it("declares the workflow draft chain as dependents of the one create-draft root", () => {
    const tools = API_QUALIFICATION_WORKFLOW_CASES.map((entry) => entry.tool);
    const dependents = API_QUALIFICATION_WORKFLOW_CASES.filter((entry) =>
      entry.dependsOn?.includes("jira.create-workflow-scheme-draft"),
    );
    expect(dependents).toHaveLength(tools.length - 1 - 9);
    for (const entry of dependents)
      expect(tools.indexOf(entry.tool)).toBeGreaterThan(
        tools.indexOf("jira.create-workflow-scheme-draft"),
      );
  });
});
