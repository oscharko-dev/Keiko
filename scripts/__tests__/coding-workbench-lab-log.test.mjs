// Tests for the lab tools that read the Activity Log of a dev checkout: the segment reader and the
// run selector (activity-log-events.mjs), the raw timeline (rawtl.mjs), the run summary and its
// ledger row (run-summary.mjs) and the contract check that makes a renamed operation or field fail
// loudly (op-contract.mjs). The contracts of the tools are checked against the committed op catalog,
// so a rename in product code fails this suite in the same change.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { activityLogSegmentFileName } from "../../packages/keiko-contracts/dist/activity-log-files.js";
import {
  flatten,
  readActivityEvents,
  resolveLogDirectory,
  selectRunEvents,
} from "../testing/coding-workbench-lab/activity-log-events.mjs";
import {
  OP_CATALOG_PATH,
  assertOperationContract,
  contractDrift,
  readOpCatalog,
  registeredOperations,
} from "../testing/coding-workbench-lab/op-contract.mjs";
import { timelineLine } from "../testing/coding-workbench-lab/rawtl.mjs";
import {
  SUMMARY_CONTRACT,
  SUMMARY_OPERATION_PREFIXES,
  formatSummary,
  ledgerPolicy,
  ledgerRow,
  summarizeRun,
} from "../testing/coding-workbench-lab/run-summary.mjs";
import {
  PROFILE_CONTRACT,
  PROFILE_OPERATION_PREFIXES,
} from "../testing/coding-workbench-lab/turn-profile.mjs";
import {
  CATALOG,
  RUN,
  RUN_SUFFIX,
  byTime,
  isoAt,
  registryLine,
} from "./support/coding-workbench-lab-events.mjs";

const TEMP_DIRECTORIES = [];

function tempDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "keiko-lab-log-"));
  TEMP_DIRECTORIES.push(directory);
  return directory;
}

afterEach(() => {
  while (TEMP_DIRECTORIES.length > 0) {
    rmSync(TEMP_DIRECTORIES.pop(), { recursive: true, force: true });
  }
});

describe("flatten and selectRunEvents", () => {
  it("lifts the extra fields to the top level, extra winning, and leaves a flat line alone", () => {
    expect(flatten({ op: "x", b: 2, extra: { a: 1 } })).toEqual({
      op: "x",
      b: 2,
      extra: { a: 1 },
      a: 1,
    });
    expect(flatten({ op: "x", a: 0, extra: { a: 1 } }).a).toBe(1);
    expect(flatten({ op: "x" })).toEqual({ op: "x" });
  });

  it("selects the run's own events and the events of the requests it spawned, oldest first", () => {
    const events = [
      { ts: isoAt(3), op: "run.late", correlationId: RUN },
      { ts: isoAt(1), op: "child.first", correlationId: "req-1", parentCorrelationId: RUN },
      { ts: isoAt(2), op: "child.second", correlationId: "req-1" },
      { ts: isoAt(0), op: "other.run", correlationId: "run-other-9999999" },
      { ts: isoAt(4), op: "no.correlation" },
    ];
    expect(selectRunEvents(events, RUN_SUFFIX).map((event) => event.op)).toEqual([
      "child.first",
      "child.second",
      "run.late",
    ]);
    expect(selectRunEvents(events, "0000000")).toEqual([]);
  });
});

describe("resolveLogDirectory", () => {
  it("prefers the flag, then KEIKO_LAB_LOG_DIR, then the state directory, then the dev default", () => {
    expect(resolveLogDirectory("rel/logs", { KEIKO_LAB_LOG_DIR: "/env/logs" })).toBe(
      resolve("rel/logs"),
    );
    expect(resolveLogDirectory(undefined, { KEIKO_LAB_LOG_DIR: "/env/logs" })).toBe(
      resolve("/env/logs"),
    );
    expect(resolveLogDirectory(undefined, { KEIKO_STATE_DIR: "/state" })).toBe(
      join(resolve("/state"), "logs"),
    );
    expect(resolveLogDirectory(undefined, {})).toBe(
      join(resolve(process.cwd(), ".keiko", "dev"), "logs"),
    );
  });
});

describe("readActivityEvents", () => {
  const identity = (hour, index = 1) => ({
    startMs: Date.UTC(2026, 9, 6, hour),
    pid: 4242,
    instanceId: "a1b2c3d4",
    index,
  });
  const jsonl = (...lines) => `${lines.join("\n")}\n`;

  it("reads the segments of the logical log in order, through the grammar, and skips what is not an event", async () => {
    const directory = tempDirectory();
    const first = activityLogSegmentFileName(identity(10), "sealed");
    const second = activityLogSegmentFileName(identity(11), "sealed");
    const twin = activityLogSegmentFileName(identity(10), "active");
    writeFileSync(join(directory, second), jsonl(JSON.stringify({ op: "second.segment", seq: 1 })));
    writeFileSync(
      join(directory, first),
      jsonl(
        JSON.stringify({ op: "first.a", seq: 1 }),
        "{ this is not json",
        "",
        "42",
        "null",
        JSON.stringify({ op: "first.b", seq: 2 }),
      ),
    );
    // The active name of an already sealed segment names the same bytes: a reader skips it.
    writeFileSync(join(directory, twin), jsonl(JSON.stringify({ op: "twin.duplicate" })));
    writeFileSync(join(directory, "notes.txt"), "not part of the log");
    const events = await readActivityEvents(directory);
    expect(events.map((event) => event.op)).toEqual(["first.a", "first.b", "second.segment"]);
  });

  it("reads an empty directory as an empty log and refuses a missing one", async () => {
    await expect(readActivityEvents(tempDirectory())).resolves.toEqual([]);
    await expect(readActivityEvents(join(tempDirectory(), "missing"))).rejects.toThrow(/ENOENT/u);
  });
});

describe("timelineLine", () => {
  const event = {
    ts: "2026-10-07T10:00:01.234Z",
    level: "warn",
    category: "gateway",
    op: "gateway.retry.scheduled",
    correlationId: "req-abcdef123456",
    pid: 1,
    seq: 2,
    instanceId: "a1b2c3d4",
    runId: RUN,
    frames: ["frame"],
    extra: { attempt: 2, list: [1, 2] },
    reason: "retryable-error",
  };

  it("prints time, level, the last six characters of the correlation, the operation and the closed fields", () => {
    expect(timelineLine(event)).toBe(
      `10:00:01.234 warn 123456 ${"gateway.retry.scheduled".padEnd(46)} reason=retryable-error attempt=2 list=[1,2]`,
    );
  });

  it("omits the envelope, caps the fields and survives an event with nothing on it", () => {
    const wide = timelineLine({ ...event, extra: { blob: "x".repeat(400) } });
    expect(wide).toHaveLength("10:00:01.234 warn 123456 ".length + 46 + 1 + 230);
    expect(wide).not.toContain("pid=");
    expect(wide).not.toContain("runId=");
    expect(() => timelineLine({})).not.toThrow();
  });
});

describe("summarizeRun, formatSummary and the ledger row", () => {
  const events = byTime([
    registryLine("coding-sidecar.gateway.outcome", 10, "req-1", {
      runId: RUN,
      outcome: "accepted",
    }),
    registryLine("coding-sidecar.gateway.outcome", 20, "req-2", {
      runId: RUN,
      outcome: "accepted",
    }),
    registryLine("coding-sidecar.gateway.outcome", 30, "req-3", { runId: RUN, outcome: "failed" }),
    registryLine("coding-sidecar.gateway.usage-settled", 10.1, "req-1", {
      runId: RUN,
      promptTokens: 4000,
      completionTokens: 120,
    }),
    registryLine("coding-sidecar.gateway.usage-settled", 20.1, "req-2", {
      runId: RUN,
      promptTokens: 5500,
      completionTokens: 300,
    }),
    registryLine("coding-runtime.editor-mutation.settled", 25, RUN, {
      state: "succeeded",
      actionKind: "edit",
      editForm: "replacements",
    }),
    registryLine("coding-runtime.edit.refused", 26, RUN, {
      reasonCode: "INVALID_EDITS",
      editForm: "replacements",
    }),
    registryLine("gateway.retry.scheduled", 27, "req-3", { attempt: 1, reason: "retryable-error" }),
    registryLine("gateway.circuit.wait", 27.5, "req-3", { outcome: "budget-refused" }),
    registryLine("coding-sidecar.gateway.rejected", 28, "req-3", {
      reason: "runtime-prompt-budget-denied",
    }),
    registryLine("coding-runtime.run.settled", 40, RUN, {
      runId: RUN,
      state: "failed",
      failureCode: "runtime-failed",
    }),
  ]);
  const summary = summarizeRun(events, RUN_SUFFIX);

  it("counts turns, tokens, edits, retries, rejections and the settlement from the closed fields", () => {
    expect(summary.runId).toBe(RUN);
    expect(summary.eventCount).toBe(events.length);
    expect([...summary.turns]).toEqual([
      ["accepted", 2],
      ["failed", 1],
    ]);
    expect(summary).toMatchObject({ promptTotal: 9500, promptMax: 5500, completionTotal: 420 });
    expect([...summary.edits]).toEqual([
      ["settled succeeded replacements", 1],
      ["refused INVALID_EDITS replacements", 1],
    ]);
    expect([...summary.retries]).toEqual([
      ["gateway.retry.scheduled retryable-error", 1],
      ["gateway.circuit.wait budget-refused", 1],
    ]);
    expect([...summary.rejected]).toEqual([["runtime-prompt-budget-denied", 1]]);
    expect(summary.settled).toEqual([
      { op: "coding-runtime.run.settled", state: "failed", failureCode: "runtime-failed" },
    ]);
    expect(summary.settledTs).toBe(isoAt(40));
  });

  it("prints the summary lines with the tallies largest first and the rejections last", () => {
    const lines = formatSummary(summary);
    expect(lines[0]).toBe(`${RUN}: 10:00:10 -> 10:00:40  events=${String(events.length)}`);
    expect(lines).toContain("model turns: 3  outcomes: accepted x2, failed x1");
    expect(lines).toContain(
      "prompt tokens (provider-reported): total=9500  max=5500  completion total=420",
    );
    expect(lines).toContain(
      "edits: refused INVALID_EDITS replacements x1, settled succeeded replacements x1",
    );
    expect(lines).toContain(
      'settled: {"op":"coding-runtime.run.settled","state":"failed","failureCode":"runtime-failed"}',
    );
    expect(lines.at(-1)).toBe("gateway rejected: runtime-prompt-budget-denied x1");
  });

  it("builds a draft ledger row that says who drove the run and answered its approvals", () => {
    const policy = ledgerPolicy({ driver: "wb-ui", approve: "all" });
    const row = ledgerRow(summary, {
      task: "T2",
      mode: "Supervised workspace",
      head: "abc1234",
      policy,
    });
    expect(row).toBe(
      `| \`${RUN}\` | T2 | Supervised workspace | \`abc1234\` | failed in 0.5 min | 3 model turns, 9,500 cumulative prompt tokens, edits: refused INVALID_EDITS replacements x1, settled succeeded replacements x1, retries/circuit: gateway.circuit.wait budget-refused x1, gateway.retry.scheduled retryable-error x1, ${policy} |`,
    );
  });

  it("keeps a placeholder for what the caller does not know, and a table cell free of pipes", () => {
    const row = ledgerRow(summary, { task: undefined, mode: "a|b" });
    expect(row).toContain("| <task> | a/b | `<head>` |");
    expect(row).toContain("<driver and approvals>");
  });

  it("calls a run with no settlement unsettled and measures it to its last event", () => {
    const unsettled = summarizeRun(
      events.filter((event) => event.op !== "coding-runtime.run.settled"),
      RUN_SUFFIX,
    );
    expect(unsettled.settledTs).toBeUndefined();
    expect(ledgerRow(unsettled)).toContain("| unsettled in 0.3 min |");
  });

  it("names the driver and the approval policy, and refuses a row that would not", () => {
    expect(ledgerPolicy({ driver: "wb-ui", approve: "all" })).toMatch(
      /^driver wb-ui, approvals all: the driver approves every permission ask once/u,
    );
    expect(ledgerPolicy({ driver: "wb-run", approve: "none" })).toMatch(
      /approvals none: the driver denies/u,
    );
    expect(ledgerPolicy({ driver: "manual" })).toBe(
      "driven by a person, who answered every approval",
    );
    for (const refused of [
      {},
      { driver: "bash", approve: "all" },
      { driver: "wb-ui" },
      { driver: "wb-run", approve: "yes" },
    ]) {
      expect(() => ledgerPolicy(refused)).toThrow(/--driver|--approve/u);
    }
  });
});

describe("the contract between the tools and the registry", () => {
  const registered = registeredOperations(CATALOG);

  it("holds for what turn-profile and run-summary read, against the committed op catalog", () => {
    expect(contractDrift(PROFILE_CONTRACT, CATALOG, PROFILE_OPERATION_PREFIXES)).toEqual([]);
    expect(contractDrift(SUMMARY_CONTRACT, CATALOG, SUMMARY_OPERATION_PREFIXES)).toEqual([]);
  });

  it("finds the reasoning counts the review asked for on both end operations of a model call", () => {
    for (const operation of ["gateway.chat.completed", "gateway.stream.completed"]) {
      expect(registered.get(operation)?.has("reasoningTokens")).toBe(true);
      expect(registered.get(operation)?.has("reasoningBytes")).toBe(true);
    }
  });

  it("does not know the operation the driver used to read and nobody ever registered", () => {
    expect(registered.has("coding-runtime.run.resumed")).toBe(false);
  });

  it("reports a field the registry dropped, an operation it renamed and a family it lost", () => {
    const drifted = structuredClone(CATALOG);
    const completed = drifted.typedRegistry.operations.find(
      (operation) => operation.op === "gateway.stream.completed",
    );
    delete completed.fields.completionTokens;
    const abandoned = drifted.typedRegistry.operations.find(
      (operation) => operation.op === "gateway.stream.abandoned",
    );
    abandoned.op = "gateway.stream.stopped";
    drifted.typedRegistry.operations = drifted.typedRegistry.operations.filter(
      (operation) => !operation.op.startsWith("gateway.retry."),
    );
    const problems = contractDrift(PROFILE_CONTRACT, drifted, PROFILE_OPERATION_PREFIXES);
    expect(problems.toSorted()).toEqual(
      [
        "field completionTokens is not registered on gateway.stream.completed",
        "no registered operation starts with gateway.retry.",
        "operation gateway.stream.abandoned is not registered",
      ].toSorted(),
    );
  });

  it("throws, naming the tool and every drifted name, and passes a contract that holds", () => {
    expect(() =>
      assertOperationContract(
        "lab-tool",
        { "no.such.operation": ["f"], "gateway.chat.failed": ["nope"] },
        [],
        CATALOG,
      ),
    ).toThrow(
      /^lab-tool reads Activity Log names the registry does not carry: operation no\.such\.operation is not registered; field nope is not registered on gateway\.chat\.failed\. Update its contract/u,
    );
    expect(() =>
      assertOperationContract(
        "lab-tool",
        { "gateway.chat.failed": ["outputExhausted"] },
        [],
        CATALOG,
      ),
    ).not.toThrow();
  });

  it("refuses a catalog without the typed registry and a missing catalog file", () => {
    expect(() => registeredOperations({})).toThrow(TypeError);
    expect(() => registeredOperations({ typedRegistry: { operations: "no" } })).toThrow(TypeError);
    const missing = join(tempDirectory(), "op-catalog.json");
    let failure;
    try {
      readOpCatalog(missing);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/cannot read the op catalog .*Keiko checkout/u);
    expect(failure.cause).toBeInstanceOf(Error);
  });

  it("reads the committed generated catalog by default", () => {
    expect(
      OP_CATALOG_PATH.endsWith(join("docs", "observability", "op-catalog.generated.json")),
    ).toBe(true);
    expect(readOpCatalog().typedRegistry.operations.length).toBeGreaterThan(0);
  });
});
