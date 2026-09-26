// Activity Log proofs for deps-activity.ts's shared emitters (#3532): the memory-audit
// state-cache seed count, the task-workspace repository registration decision (registered /
// refused), and the server runtime shutdown lifecycle line. Each test drives the real exported
// emitter with a capturing sink and proves the persisted line against its registered operation.

import { describe, expect, it } from "vitest";
import { createBufferedServerLogSink } from "./observability/server-log.js";
import {
  logMemoryAuditStateCacheSeeded,
  logRuntimeShutdown,
  logTaskWorkspaceRepositoryRegistration,
} from "./deps-activity.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

describe("logMemoryAuditStateCacheSeeded — Activity Log proof", () => {
  it("writes one body-free memory.audit.state-cache.seeded line carrying the seeded record count", () => {
    const sink = createBufferedServerLogSink();

    logMemoryAuditStateCacheSeeded(sink, "req-memory-audit-seed-0001", 42);

    expect(sink.events).toHaveLength(1);
    const [line] = sink.events;
    expect(line).toMatchObject({
      category: "memory",
      op: "memory.audit.state-cache.seeded",
      correlationId: "req-memory-audit-seed-0001",
      extra: { recordCount: 42, completeness: "complete", loss: "none" },
    });
    const proven = expectActivityLogProof(
      "memory.audit.state-cache.seeded.count",
      formatActivityLogProofLine(line ?? {}),
    );
    expect(proven).toMatchObject({ recordCount: 42 });
  });
});

describe("logTaskWorkspaceRepositoryRegistration — Activity Log proof", () => {
  it("writes a body-free task-workspace.repository.registered line at the restricted grant", () => {
    const sink = createBufferedServerLogSink();

    logTaskWorkspaceRepositoryRegistration(sink, "req-repo-registration-0001", {
      outcome: "registered",
      repositoryId: "repo_test",
      granted: false,
    });

    expect(sink.events).toHaveLength(1);
    const [line] = sink.events;
    expect(line).toMatchObject({
      category: "security",
      op: "task-workspace.repository.registered",
      correlationId: "req-repo-registration-0001",
      extra: { repositoryId: "repo_test", granted: false, completeness: "complete", loss: "none" },
    });
    const proven = expectActivityLogProof(
      "task-workspace.repository.registered.restricted",
      formatActivityLogProofLine(line ?? {}),
    );
    expect(proven).toMatchObject({ repositoryId: "repo_test", granted: false });
  });

  it("writes a body-free task-workspace.repository.registration-refused line with its closed reason", () => {
    const sink = createBufferedServerLogSink();

    logTaskWorkspaceRepositoryRegistration(sink, "req-repo-registration-0002", {
      outcome: "refused",
      repositoryId: "repo_test",
      reason: "ui-database-inside-repository",
    });

    expect(sink.events).toHaveLength(1);
    const [line] = sink.events;
    expect(line).toMatchObject({
      level: "warn",
      category: "security",
      op: "task-workspace.repository.registration-refused",
      correlationId: "req-repo-registration-0002",
      errorKind: "unsafe-target",
      extra: {
        repositoryId: "repo_test",
        reason: "ui-database-inside-repository",
        completeness: "complete",
        loss: "none",
      },
    });
    const proven = expectActivityLogProof(
      "task-workspace.repository.registration-refused.reason",
      formatActivityLogProofLine(line ?? {}),
    );
    expect(proven).toMatchObject({ reason: "ui-database-inside-repository" });
  });
});

describe("logRuntimeShutdown — Activity Log proof", () => {
  it("writes a body-free server.runtime.shutdown line for a clean completed shutdown", () => {
    const sink = createBufferedServerLogSink();

    logRuntimeShutdown(sink, "req-runtime-shutdown-0001", {
      state: "completed",
      openSseStreamCount: 0,
      activeRunCount: 0,
      durationMs: 12,
      runtimeShutdown: "ended",
      cleanup: "completed",
    });

    expect(sink.events).toHaveLength(1);
    const [line] = sink.events;
    expect(line).toMatchObject({
      category: "process",
      op: "server.runtime.shutdown",
      correlationId: "req-runtime-shutdown-0001",
      extra: {
        state: "completed",
        openSseStreamCount: 0,
        activeRunCount: 0,
        durationMs: 12,
        runtimeShutdown: "ended",
        cleanup: "completed",
      },
    });
    const proven = expectActivityLogProof(
      "server.runtime.shutdown.lifecycle",
      formatActivityLogProofLine(line ?? {}),
    );
    expect(proven).toMatchObject({ state: "completed", runtimeShutdown: "ended" });
  });
});
