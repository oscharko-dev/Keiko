import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONNECTED_CONTEXT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/connected-context";
import { CancelledError } from "@oscharko-dev/keiko-model-gateway";
import {
  FileTooLargeError,
  PathDeniedError,
  PathEscapeError,
  WorkspaceReadError,
  type WorkspaceFs,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-workspace";
import {
  nodeWorkspaceFs,
  WorkspaceDescriptorReadError,
} from "@oscharko-dev/keiko-workspace/internal/fs";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { observedFailureQuery } from "../../../tests/support/observed-failure-query.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import {
  retrieveConnectedContextPack,
  type OrchestratorInput,
  type RetrievalOnlyOutput,
} from "./grounded-orchestrator.js";

import { createSymbolReadFailureObserver } from "./grounded-symbol-diagnostics.js";
import { createServerLogger } from "./observability/index.js";

const CORRELATION = "symbol-read-failure-request";
const PRIVATE_DETAIL = "private-customer-source-and-error-content";
const NOW = 1_700_000_000_000;
let root = "";

function fixtureInput(): OrchestratorInput {
  return {
    workspaceRoot: root,
    scope: {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      scopeId: "symbol-failure-scope",
      workspaceRoot: root,
      kind: "workspace-root",
      relativePaths: [],
      conversationId: undefined,
      connectedAtMs: NOW,
      explicitConnection: true,
    },
    query: {
      kind: "natural-language",
      text: "Trace FailureProbe implementations",
      caseSensitive: false,
      maxResults: 50,
      emittedAtMs: NOW,
    },
  };
}

function workspace(): WorkspaceInfo {
  return {
    root,
    selectedRoot: root,
    name: "symbol-fixture",
    version: "0.0.0",
    testFramework: "vitest",
    sourceDirs: ["private-one", "private-two"],
    testDirs: [],
    languages: ["typescript"],
    ignoreLines: [],
  };
}

function observedRetrieval(failure?: Error): {
  pending: Promise<RetrievalOnlyOutput>;
  activity: ReturnType<typeof createBufferedServerLogSink>;
  symbolReads: string[];
} {
  const read = nodeWorkspaceFs.readFileUtf8SameDescriptor;
  if (read === undefined) throw new TypeError("Missing bounded descriptor fixture");
  const activity = createBufferedServerLogSink();
  const symbolReads: string[] = [];
  const fs: WorkspaceFs = {
    ...nodeWorkspaceFs,
    readFileUtf8SameDescriptor: (...args): ReturnType<typeof read> => {
      if (new Error().stack?.includes("boundedSymbolFileText") === true) {
        symbolReads.push(args[0]);
        if (failure !== undefined && args[0].includes("private-one")) throw failure;
      }
      return read(...args);
    },
  };
  const pending = retrieveConnectedContextPack(fixtureInput(), {
    correlationId: CORRELATION,
    activityLog: activity,
    answerer: { answer: (): Promise<string> => Promise.resolve("unused retrieval-only answerer") },
    fs,
    detectWorkspace: workspace,
    nowMs: () => NOW,
  });
  return { pending, activity, symbolReads };
}

describe("symbol-line read failure ownership", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "keiko-symbol-failure-"));
    for (const directory of ["private-one", "private-two"]) {
      mkdirSync(join(root, directory));
      writeFileSync(
        join(root, directory, "FailureProbe.ts"),
        "export function FailureProbe(): number { return 1; }\n",
      );
    }
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ["EIO", "unavailable"],
    ["EACCES", "permission-denied"],
  ])("records %s once and preserves a healthy definition", async (code, errorKind) => {
    const failure = Object.assign(new Error(PRIVATE_DETAIL), { code });
    const { pending, activity, symbolReads } = observedRetrieval(failure);
    const result = await pending;
    expect(symbolReads.some((path) => path.includes("private-one"))).toBe(true);
    expect(symbolReads.some((path) => path.includes("private-two"))).toBe(true);
    expect(result.pack.files.map((file) => file.scopePath)).toContain(
      "private-two/FailureProbe.ts",
    );
    const unavailable = activity.events.filter(
      (event) => event.op === "search.symbol-line.unavailable",
    );
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]).toMatchObject({
      level: "warn",
      correlationId: CORRELATION,
      errorKind,
      extra: { completeness: "partial", loss: "none" },
    });
    expect(unavailable[0]?.extra?.scopePathDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(unavailable)).not.toContain(PRIVATE_DETAIL);
    expect(JSON.stringify(unavailable)).not.toContain("private-one");
    expect(
      activity.events.filter((event) => event.op === "search.connected-context.failed"),
    ).toEqual([]);
  });

  it.each([
    [new WorkspaceDescriptorReadError("changed"), "source-changed", "target-mutated"],
    [
      new WorkspaceDescriptorReadError("directory-membership-changed"),
      "source-changed",
      "target-mutated",
    ],
    [new WorkspaceDescriptorReadError("not-regular"), "source-changed", "target-mutated"],
    [new WorkspaceDescriptorReadError("hard-link"), "containment-denied", "permission-denied"],
    [new WorkspaceDescriptorReadError("outside-root"), "containment-denied", "permission-denied"],
    [new WorkspaceDescriptorReadError("symbolic-link"), "containment-denied", "permission-denied"],
    [new WorkspaceDescriptorReadError("too-large"), "read-limit", "unavailable"],
    [
      new PathDeniedError(PRIVATE_DETAIL, PRIVATE_DETAIL),
      "containment-denied",
      "permission-denied",
    ],
    [
      new PathEscapeError(PRIVATE_DETAIL, PRIVATE_DETAIL),
      "containment-denied",
      "permission-denied",
    ],
    [new FileTooLargeError(PRIVATE_DETAIL, PRIVATE_DETAIL, 3, 2), "read-limit", "unavailable"],
    [
      new WorkspaceReadError(PRIVATE_DETAIL, PRIVATE_DETAIL),
      "filesystem-unavailable",
      "unavailable",
    ],
  ] as const)("classifies expected descriptor/workspace failure %s", (error, reason, errorKind) => {
    const activity = createBufferedServerLogSink();
    const observe = createSymbolReadFailureObserver(
      createServerLogger({ sink: activity, level: "debug" }),
      CORRELATION,
    );
    observe(error, "private-one/FailureProbe.ts");
    expect(activity.events).toHaveLength(1);
    expect(activity.events[0]).toMatchObject({
      op: "search.symbol-line.unavailable",
      correlationId: CORRELATION,
      errorKind,
      extra: { reason },
    });
    expect(JSON.stringify(activity.events)).not.toContain(PRIVATE_DETAIL);
    expect(JSON.stringify(activity.events)).not.toContain("private-one");
  });

  it("keeps error classification when activity initialization already failed", () => {
    const observe = createSymbolReadFailureObserver(undefined, undefined);
    const unavailable = Object.assign(new Error(PRIVATE_DETAIL), { code: "EIO" });
    expect(() => {
      observe(unavailable, "private-one/FailureProbe.ts");
    }).not.toThrow();
    const unexpected = new TypeError(PRIVATE_DETAIL);
    expect(() => {
      observe(unexpected, "private-one/FailureProbe.ts");
    }).toThrow(unexpected);
  });

  it("persists and reconstructs the actual degraded symbol-read diagnostic", async () => {
    const failure = Object.assign(new Error(PRIVATE_DETAIL, { cause: new Error(PRIVATE_DETAIL) }), {
      code: "EIO",
    });
    const { pending, activity } = observedRetrieval(failure);
    await pending;
    const event = activity.events.find((entry) => entry.op === "search.symbol-line.unavailable");
    if (event === undefined) throw new TypeError("Missing symbol-read diagnostic");
    const line = formatActivityLogProofLine(event);
    const persisted = expectActivityLogProof("search.symbol-line.unavailable.line", line);
    expect(persisted).toMatchObject({
      level: "warn",
      correlationId: CORRELATION,
      errorKind: "unavailable",
      reason: "filesystem-unavailable",
      failureKind: "EIO",
      causeChain: ["Error"],
      completeness: "partial",
      loss: "none",
    });
    expect(persisted.frames).toEqual(expect.arrayContaining([expect.any(String)]));
    expect(line).not.toContain(PRIVATE_DETAIL);
    expect(line).not.toContain("private-one");
    const analyzed = observedFailureQuery([event]);
    expect(analyzed.events.filter((entry) => entry.parsed.view.op === event.op)).toHaveLength(1);
  });

  it("propagates a programmer error unchanged to the terminal failure owner", async () => {
    const failure = new TypeError(PRIVATE_DETAIL);
    const { pending, activity } = observedRetrieval(failure);
    await expect(pending).rejects.toBe(failure);
    expect(
      activity.events.filter((event) => event.op === "search.symbol-line.unavailable"),
    ).toEqual([]);
    const terminal = activity.events.filter(
      (event) => event.op === "search.connected-context.failed",
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ correlationId: CORRELATION, errorKind: "internal" });
    expect(JSON.stringify(terminal)).not.toContain(PRIVATE_DETAIL);
  });

  it("keeps cancellation distinct from unavailable symbol evidence", async () => {
    const failure = new CancelledError(PRIVATE_DETAIL);
    const { pending, activity } = observedRetrieval(failure);
    await expect(pending).rejects.toBe(failure);
    expect(
      activity.events.filter((event) => event.op === "search.symbol-line.unavailable"),
    ).toEqual([]);
    expect(
      activity.events.find((event) => event.op === "search.connected-context.failed"),
    ).toMatchObject({
      correlationId: CORRELATION,
      errorKind: "cancelled",
    });
  });
});
