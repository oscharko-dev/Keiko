import { resetServerLogger } from "../support/activity-log-test-support.js";
// End-to-end Activity Log scenarios (#3532): the tools-workflows surface (coding-runtime,
// tool-catalog, coding-app-session/coding-context, task-workspace and workspace-script-trust).
//
// Each scenario drives a production entry point of that surface into one failure mode with the
// real production file writer under a temporary KEIKO_STATE_DIR, then reconstructs the persisted
// log through `keiko support analyze` to a complete report (tests/support/activity-log-scenario.ts).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandTerminationEvidence } from "@oscharko-dev/keiko-contracts";
import { PathDeniedError } from "@oscharko-dev/keiko-workspace";

import { defaultServerDiagnosticSink } from "../../packages/keiko-server/src/diagnostics-log.js";
import {
  logCommandTermination,
  processServerLogSink,
} from "../../packages/keiko-server/src/process-log-sink.js";
import {
  emitToolLifecycleEvent,
  type CatalogLifecycleLogPort,
} from "../../packages/keiko-server/src/tool-catalog/catalogToolLifecycle.js";
import { recordWorkspaceRootDenial } from "../../packages/keiko-server/src/workspace-root-denial-log.js";
import { recordRepositoryRelay } from "../../packages/keiko-server/src/repository-relay/repositoryRelayActivity.js";
import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../support/activity-log-proof.js";
import { expectActivityLogScenario } from "../support/activity-log-scenario.js";

const CATALOG_REVISION = "a".repeat(64);
const PROJECTION_DIGEST = "b".repeat(64);
const CATALOG_PROFILE = { id: "managed-opencode", version: 1 } as const;

// The tool-catalog lifecycle port a real composition site builds: the production file writer for
// `primary`, the production diagnostics sink for the (unreachable, on a valid event) failure path.
function toolCatalogLogPort(): CatalogLifecycleLogPort {
  return { primary: processServerLogSink(), diagnostics: defaultServerDiagnosticSink };
}

describe("Activity Log scenario: tools-workflows", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-scenario-tools-workflows-"));
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
    vi.stubEnv("KEIKO_LOG_LEVEL", "debug");
    resetServerLogger();
  });

  afterEach(() => {
    resetServerLogger();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("reconstructs a terminated command to a complete crash trace", async () => {
    const startedAtMs = Date.now();
    const evidence: CommandTerminationEvidence = {
      reason: "timeout",
      childPid: 44_321,
      windowsTreeKill: "not-attempted",
    };
    logCommandTermination(processServerLogSink(), "tools-workflows-crash-0001", evidence);

    const trace = await expectActivityLogScenario("tools-workflows.crash", {
      stateDir,
      startedAtMs,
      expectedOps: ["command.terminated"],
    });
    expect(trace.failureClasses).toEqual(expect.arrayContaining(["command-termination"]));

    const [line] = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "command.terminated",
    );
    expect(expectActivityLogProof("command.terminated.line", line ?? "")).toMatchObject({
      correlationId: "tools-workflows-crash-0001",
      reason: "timeout",
      childPid: 44_321,
      windowsTreeKill: "not-attempted",
    });
  });

  it("reconstructs a refused tool binding to a complete dependency-failure trace", async () => {
    const startedAtMs = Date.now();
    emitToolLifecycleEvent(toolCatalogLogPort(), {
      op: "tool-catalog.bind-unavailable",
      correlationId: "tools-workflows-dependency-0001",
      catalogRevision: CATALOG_REVISION,
      profile: CATALOG_PROFILE,
      projectionDigest: PROJECTION_DIGEST,
      readiness: "unavailable",
      reason: "handler-unavailable",
    });

    const trace = await expectActivityLogScenario("tools-workflows.dependency-failure", {
      stateDir,
      startedAtMs,
      expectedOps: ["tool-catalog.bind-unavailable"],
    });
    expect(trace.failureClasses).toEqual(
      expect.arrayContaining(["tool-catalog-binding-unavailable"]),
    );

    const [line] = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "tool-catalog.bind-unavailable",
    );
    expect(
      expectActivityLogProof("tool-catalog.bind-unavailable.emitted-line", line ?? ""),
    ).toMatchObject({
      correlationId: "tools-workflows-dependency-0001",
      readiness: "unavailable",
      reason: "handler-unavailable",
    });
  });

  it("reconstructs a discarded late tool completion to a complete loss trace", async () => {
    const startedAtMs = Date.now();
    emitToolLifecycleEvent(toolCatalogLogPort(), {
      op: "tool-catalog.completion-discarded",
      correlationId: "tools-workflows-loss-0001",
      catalogRevision: CATALOG_REVISION,
      profile: CATALOG_PROFILE,
      projectionDigest: PROJECTION_DIGEST,
      invocationId: "invocation-loss-0001",
      toolRef: { canonicalId: "keiko.repo.search", contractVersion: 1 },
      settlementId: "settlement-loss-0001",
      reason: "late-completion",
    });

    const trace = await expectActivityLogScenario("tools-workflows.loss", {
      stateDir,
      startedAtMs,
      expectedOps: ["tool-catalog.completion-discarded"],
    });
    expect(trace.failureClasses).toEqual(expect.arrayContaining(["tool-catalog-late-completion"]));

    const [line] = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "tool-catalog.completion-discarded",
    );
    expect(
      expectActivityLogProof("tool-catalog.completion-discarded.emitted-line", line ?? ""),
    ).toMatchObject({
      correlationId: "tools-workflows-loss-0001",
      reason: "late-completion",
      lossState: "event-dropped",
    });
  });

  it("reconstructs a denied workspace root request to a complete rejection trace", async () => {
    const startedAtMs = Date.now();
    recordWorkspaceRootDenial(
      new PathDeniedError("denied customer secret", "/private/customer/.env"),
      {
        activityLog: processServerLogSink(),
        correlationId: "tools-workflows-rejection-0001",
      },
    );

    const trace = await expectActivityLogScenario("tools-workflows.rejection", {
      stateDir,
      startedAtMs,
      expectedOps: ["workspace.root.denied"],
    });
    expect(trace.failureClasses).toEqual(expect.arrayContaining(["workspace-root-denial"]));

    const [line] = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "workspace.root.denied",
    );
    expect(expectActivityLogProof("workspace.root.denied.line", line ?? "")).toMatchObject({
      correlationId: "tools-workflows-rejection-0001",
      errorKind: "permission-denied",
      decision: "denied",
      reason: "denied-locus",
    });
  });

  // #4530: a run's repository refuses the login. The relay's bind, the upstream rejection (the
  // `401` a build otherwise reports as "Unauthorized") and the binding's settled summary stay on the
  // run's correlation, so `keiko support analyze` shows them in that run's timeline.
  it("reconstructs a repository that refuses the relay's login to a dependency-failure trace", async () => {
    const startedAtMs = Date.now();
    const sink = processServerLogSink();
    const runId = "tools-workflows-relay-0001";
    recordRepositoryRelay(sink, runId, { action: "bind", outcome: "bound", ecosystem: "maven" });
    recordRepositoryRelay(sink, runId, {
      action: "request",
      outcome: "failed",
      reason: "upstream-rejected",
      ecosystem: "maven",
      method: "GET",
      credentialKind: "basic",
      upstreamStatusClass: "4xx",
    });
    recordRepositoryRelay(sink, runId, {
      action: "release",
      outcome: "settled",
      ecosystem: "maven",
      requestCount: 1,
      relayedCount: 1,
      upstreamClientErrorCount: 1,
      responseBytes: 0,
      durationMs: 12,
    });

    const relayOp = "coding-runtime.repository-relay";
    const trace = await expectActivityLogScenario("tools-workflows.dependency-failure", {
      stateDir,
      startedAtMs,
      expectedOps: [relayOp, relayOp, relayOp],
    });
    expect(trace.failureClasses).toEqual(
      expect.arrayContaining(["coding-runtime-repository-relay"]),
    );

    const lines = persistedActivityLogLines(readPersistedActivityLog(stateDir), relayOp);
    const proven = lines.map((line) =>
      expectActivityLogProof("coding-runtime.repository-relay.emitted-line", line),
    );
    expect(proven).toEqual([
      expect.objectContaining({ correlationId: runId, action: "bind", outcome: "bound" }),
      expect.objectContaining({
        correlationId: runId,
        action: "request",
        outcome: "failed",
        reason: "upstream-rejected",
        upstreamStatusClass: "4xx",
      }),
      expect.objectContaining({
        correlationId: runId,
        action: "release",
        outcome: "settled",
        upstreamClientErrorCount: 1,
      }),
    ]);
  });
});
