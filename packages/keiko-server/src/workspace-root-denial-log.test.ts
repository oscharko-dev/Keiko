import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";

import { PathDeniedError } from "@oscharko-dev/keiko-workspace";
import { activityLogEventRegistration } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { describe, expect, it } from "vitest";
import {
  recordManagedRootRequestDenial,
  recordWorkspaceRootDenial,
  recordWorkspaceRootDenied,
} from "./workspace-root-denial-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

describe("workspace root denial activity", () => {
  it("emits the authoritative typed denial without path or message content", () => {
    const sink = createBufferedServerLogSink();
    const deniedPath = "/private/customer/.env";
    const message = "denied customer secret";

    recordWorkspaceRootDenial(new PathDeniedError(message, deniedPath), {
      activityLog: sink,
      correlationId: "workspace-denial-0001",
    });

    expect(sink.events).toHaveLength(1);
    const event = sink.events[0];
    expect(event).toMatchObject({
      level: "warn",
      category: "security",
      op: "workspace.root.denied",
      correlationId: "workspace-denial-0001",
      errorKind: "permission-denied",
      extra: {
        decision: "denied",
        reason: "denied-locus",
        failureKind: "WORKSPACE_PATH_DENIED",
        completeness: "complete",
        loss: "none",
      },
    });
    expect(
      activityLogEventRegistration(
        (event ?? {}) as unknown as Readonly<Record<PropertyKey, unknown>>,
      ),
    ).toMatchObject({ emitter: "workspace-root-denial-log.recordWorkspaceRootDenied" });
    expect(JSON.stringify(event)).not.toContain(deniedPath);
    expect(JSON.stringify(event)).not.toContain(message);
    const proven = expectActivityLogProof(
      "workspace.root.denied.line",
      formatActivityLogProofLine(event ?? {}),
    );
    expect(proven).toMatchObject({ decision: "denied", reason: "denied-locus" });
  });

  it("uses closed authority and internal failure kinds across every producer", () => {
    const sink = createBufferedServerLogSink();
    const context = { activityLog: sink, correlationId: "workspace-denial-0002" };

    recordManagedRootRequestDenial("managed-root-session-authority-missing", context);
    recordWorkspaceRootDenied(
      {
        reason: "managed-root-resolution-failed",
        failureKind: "Error",
        errorKind: "internal",
      },
      context,
    );

    expect(sink.events).toHaveLength(2);
    expect(sink.events[0]).toMatchObject({
      errorKind: "authority-denied",
      extra: { failureKind: "DENIED" },
    });
    expect(sink.events[1]).toMatchObject({
      errorKind: "internal",
      extra: { failureKind: "Error" },
    });
  });

  it("rejects unregistered denial fields and excludes them from runtime evidence", () => {
    const sink = createBufferedServerLogSink();
    const unregisteredPath = "/private/customer";
    recordWorkspaceRootDenied(
      {
        // @ts-expect-error workspace paths are not registered body-free evidence
        workspacePath: unregisteredPath,
        reason: "managed-root-ownership",
        failureKind: "WORKSPACE_MANAGED_AUTHORITY_DENIED",
        errorKind: "authority-denied",
      },
      { activityLog: sink },
    );

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      errorKind: "authority-denied",
      extra: {
        reason: "managed-root-ownership",
        failureKind: "WORKSPACE_MANAGED_AUTHORITY_DENIED",
      },
    });
    expect(JSON.stringify(sink.events[0])).not.toContain(unregisteredPath);
  });
});
