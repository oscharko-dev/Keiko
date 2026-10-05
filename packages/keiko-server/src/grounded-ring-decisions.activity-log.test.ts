import { describe, expect, it } from "vitest";
import { DEFAULT_EXPLORATION_BUDGET } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { retrieveConnectedContextPack, type OrchestratorInput } from "./grounded-orchestrator.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

const ROOT = "/private/customer/ring-decisions";
const CORRELATION = "ring-decision-review-0001";
type Log = ReturnType<typeof createBufferedServerLogSink>;
interface RetrievalResult {
  readonly output: Awaited<ReturnType<typeof retrieveConnectedContextPack>>;
  readonly log: Log;
  readonly completed: Log["events"][number] | undefined;
  readonly source: Log["events"][number] | undefined;
}
interface ReadControl {
  readonly fs?: (base: WorkspaceFs) => WorkspaceFs;
  readonly nowMs?: () => number;
}

function input(text: string, budget: NonNullable<OrchestratorInput["budget"]>): OrchestratorInput {
  return {
    workspaceRoot: ROOT,
    scope: {
      schemaVersion: "1",
      scopeId: "fixture",
      workspaceRoot: ROOT,
      kind: "workspace-root",
      relativePaths: [],
      conversationId: undefined,
      connectedAtMs: 0,
      explicitConnection: true,
    },
    query: { kind: "natural-language", text, maxResults: 20, caseSensitive: false, emittedAtMs: 0 },
    budget,
  };
}

async function retrieve(
  text: string,
  files: Readonly<Record<string, string>>,
  budget = DEFAULT_EXPLORATION_BUDGET,
  control: ReadControl = {},
): Promise<RetrievalResult> {
  const log = createBufferedServerLogSink();
  const base = memFs(ROOT, files);
  const output = await retrieveConnectedContextPack(input(text, budget), {
    correlationId: CORRELATION,
    activityLog: log,
    fs: control.fs?.(base) ?? base,
    nowMs: control.nowMs ?? ((): number => 0),
    detectWorkspace: () => ({
      root: ROOT,
      selectedRoot: ROOT,
      name: "fixture",
      version: undefined,
      testFramework: "unknown",
      sourceDirs: [],
      testDirs: [],
      languages: [],
      ignoreLines: [],
    }),
    answerer: { answer: () => Promise.resolve("unused") },
  });
  const completed = log.events.find((event) => event.op === "search.connected-context.completed");
  const source = log.events.find((event) => event.op === "search.connected-context.source-details");
  return { output, log, completed, source };
}

function assertPartition(result: Awaited<ReturnType<typeof retrieve>>): void {
  const extra = result.completed?.extra;
  const executed = extra?.executedRingKinds;
  const skipped = extra?.skippedRingKinds;
  const stopped = extra?.stoppedRingKinds;
  expect(Array.isArray(executed)).toBe(true);
  expect(Array.isArray(skipped)).toBe(true);
  expect(Array.isArray(stopped)).toBe(true);
  const partition = [executed, skipped, stopped].flat();
  expect(partition).toHaveLength(result.output.plan.rings.length);
  expect(new Set(partition)).toEqual(new Set(result.output.plan.rings.map((ring) => ring.kind)));
}

function assertCanonical(result: Awaited<ReturnType<typeof retrieve>>, source = false): void {
  const event = source ? result.source : result.completed;
  const proof = source
    ? "search.connected-context.source-details.line"
    : "search.connected-context.completed.line";
  const line = expectActivityLogProof(proof, formatActivityLogProofLine(event ?? {}));
  expect(line).toHaveProperty("correlationId", CORRELATION);
  expect(line).toMatchObject(event?.extra ?? {});
  expect(result.log.lines().join("\n")).not.toContain(ROOT);
}

function onContentRead(base: WorkspaceFs, observe: (path: string) => void): WorkspaceFs {
  const read = base.readFileBytes;
  if (read === undefined) throw new TypeError("Fixture requires a bounded byte reader");
  return {
    ...base,
    readFileBytes: (...args): Promise<Uint8Array> => {
      observe(args[0]);
      return read(...args);
    },
  };
}

describe("ring and listing decision evidence", () => {
  it.each([
    {
      text: 'Find exact identifier "InvoiceReference".',
      files: { "manual.html": "InvoiceReference appears here." },
      reason: "complete-exact-lookup",
      ringReason: "complete-exact-lookup",
    },
    {
      text: "What value is documented for InvoiceReference?",
      files: { "manual.html": "InvoiceReference appears here." },
      reason: "ordinary-document",
      ringReason: "no-git-metadata",
    },
    {
      text: 'Find exact identifier "ABSENT_PRIVATE_METRIC".',
      files: { "manual.html": "Unrelated handbook content." },
      reason: "literal-absence",
      ringReason: "no-git-metadata",
    },
  ])("records actual $reason decisions", async (test) => {
    const result = await retrieve(test.text, test.files);
    assertPartition(result);
    expect(result.completed?.extra).toMatchObject({
      augmentationDisposition: "skipped",
      augmentationSkipped: true,
      augmentationSkipReason: test.reason,
    });
    expect(result.completed?.extra?.ringSkipReasons).toContain(test.ringReason);
    assertCanonical(result);
  });

  it("partitions the unstarted rings when the search-call budget is exhausted", async () => {
    const result = await retrieve(
      "Trace CheckoutMismatch through code and callers.",
      { "source.ts": "export const CheckoutMismatch = 1;" },
      { ...DEFAULT_EXPLORATION_BUDGET, searchCallsMax: 1 },
    );
    assertPartition(result);
    expect(result.completed?.extra).toMatchObject({
      executedRingKinds: ["lexical"],
      augmentationDisposition: "skipped",
      augmentationSkipReason: "budget-exhausted",
    });
    expect(result.completed?.extra?.stoppedRingKinds).not.toEqual([]);
    expect(result.output.pack.usage.searchCalls).toBe(1);
    assertCanonical(result);
  });

  it("records all rings as stopped and augmentation not reached for an initial blocked budget", async () => {
    const result = await retrieve(
      'Find exact identifier "InvoiceReference".',
      { "manual.html": "InvoiceReference" },
      { ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 0 },
    );
    assertPartition(result);
    expect(result.completed?.extra).toMatchObject({
      executedRingKinds: [],
      skippedRingKinds: [],
      augmentationDisposition: "not-reached",
      augmentationSkipped: false,
    });
    expect(result.source?.extra?.overviewListingFallback).toBe("not-evaluated");
    assertCanonical(result);
  });

  it.each([
    { calls: 1, disposition: "skipped-budget", charged: 1 },
    { calls: 2, disposition: "used", charged: 2 },
  ])("accounts for overview fallback with $calls available search calls", async (test) => {
    const result = await retrieve(
      "Give me an overview of this repository.",
      { "manual.txt": "z".repeat(2048) },
      { ...DEFAULT_EXPLORATION_BUDGET, searchCallsMax: test.calls, excerptBytesMax: 512 },
    );
    expect(result.output.plan.retrievalIntent).toBe("repository-overview");
    expect(result.source?.extra?.overviewListingFallback).toBe(test.disposition);
    expect(result.output.pack.usage.searchCalls).toBe(test.charged);
    if (test.disposition === "used") {
      expect(result.output.pack.diagnostics?.coverage?.filesDiscovered).toBe(2);
      expect(result.output.pack.diagnostics?.coverage?.filesScanned).toBe(2);
    } else {
      expect(result.output.pack.uncertainty.some((entry) => entry.kind === "budget-clipped")).toBe(
        true,
      );
    }
    assertPartition(result);
    assertCanonical(result, true);
  });

  it("records augmentation use and an unnecessary listing when the known-fit overview already has evidence", async () => {
    const result = await retrieve("Give me an overview of this repository.", {
      "manual.txt": "A short handbook.",
    });
    assertPartition(result);
    expect(result.completed?.extra).toMatchObject({
      augmentationDisposition: "used",
      augmentationSkipped: false,
    });
    expect(result.source?.extra?.overviewListingFallback).toBe("not-needed");
    assertCanonical(result);
  });

  it("preserves incomplete term-search coverage when a healthy overview listing follows", async () => {
    let failed = false;
    const result = await retrieve(
      "Give me an overview of this repository.",
      {
        "z-failed.txt": "x".repeat(2048),
        "a-healthy.txt": "z".repeat(2048),
      },
      { ...DEFAULT_EXPLORATION_BUDGET, searchCallsMax: 2, excerptBytesMax: 512 },
      {
        fs: (base) =>
          onContentRead(base, (path) => {
            if (path.endsWith("/z-failed.txt") && !failed) {
              failed = true;
              throw Object.assign(new Error("private transient failure"), { code: "EIO" });
            }
          }),
      },
    );
    expect(failed).toBe(true);
    expect(result.source?.extra?.overviewListingFallback).toBe("used");
    expect(result.output.pack.usage.searchCalls).toBe(2);
    expect(result.output.pack.diagnostics?.coverage).toMatchObject({
      incomplete: true,
      reasons: ["io-error"],
      filesDiscovered: 4,
    });
    expect(result.output.pack.files.map((file) => file.scopePath)).toContain("a-healthy.txt");
    expect(result.log.lines().join("\n")).not.toContain("private transient failure");
    assertCanonical(result, true);
  });

  it("does not reserve an overview listing after the absolute deadline interrupts the term search", async () => {
    let now = 0;
    let reads = 0;
    const result = await retrieve(
      "Give me an overview of this repository.",
      {
        "manual.txt": "z".repeat(2048),
        "second.txt": "q".repeat(2048),
      },
      { ...DEFAULT_EXPLORATION_BUDGET, elapsedMsMax: 10, searchCallsMax: 2, excerptBytesMax: 512 },
      {
        nowMs: () => now,
        fs: (base) =>
          onContentRead(base, () => {
            reads += 1;
            now = 10;
          }),
      },
    );
    expect(reads).toBe(1);
    expect(result.source?.extra?.overviewListingFallback).toBe("skipped-stopped");
    expect(result.output.pack.usage.searchCalls).toBe(1);
    expect(result.output.pack.diagnostics?.coverage).toMatchObject({
      incomplete: true,
      reasons: ["timeout"],
    });
    assertPartition(result);
    assertCanonical(result, true);
  });
});
