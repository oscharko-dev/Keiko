import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";

import { PathDeniedError, WorkspaceNotFoundError } from "@oscharko-dev/keiko-workspace";
import { activityLogEventRegistration } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { describe, expect, it } from "vitest";
import {
  isExpectedWorkspaceRootFailure,
  recordManagedRootRequestDenial,
  recordWorkspaceRootDenial,
  recordWorkspaceRootDenied,
  recordWorkspaceRootUnavailable,
} from "./workspace-root-denial-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

describe("workspace root denial activity", () => {
  it("recognizes only declared root failures and known filesystem errors", () => {
    expect(
      isExpectedWorkspaceRootFailure(new WorkspaceNotFoundError("gone", "/private/root")),
    ).toBe(true);
    for (const code of [
      "ENOENT",
      "ENOTDIR",
      "EACCES",
      "EPERM",
      "ELOOP",
      "EIO",
      "ESTALE",
      "EMFILE",
      "ENFILE",
      "ETIMEDOUT",
    ])
      expect(
        isExpectedWorkspaceRootFailure(Object.assign(new Error("private-root"), { code })),
      ).toBe(true);
    for (const error of [
      new TypeError("private-bug"),
      new Error("private-bug"),
      { code: "UNKNOWN_ROOT_CODE" },
      null,
    ])
      expect(isExpectedWorkspaceRootFailure(error)).toBe(false);
    const hostile = Object.defineProperty({}, "code", {
      get: () => {
        throw new Error("private-getter");
      },
    });
    expect(isExpectedWorkspaceRootFailure(hostile)).toBe(false);
  });

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

  it.each([
    ["ENOENT", "unavailable"],
    ["ENOTDIR", "unavailable"],
    ["ELOOP", "unavailable"],
    ["EACCES", "permission-denied"],
    ["EPERM", "permission-denied"],
  ])("preserves the actual root failure %s in a body-free stored line", (code, errorKind) => {
    const sink = createBufferedServerLogSink();
    const error = Object.assign(new Error("private-root-message-canary"), { code });
    error.stack =
      "Error: private-root-message-canary\n    at root (/private/work/Keiko/packages/keiko-server/src/grounded-qa.ts:584:9)";
    recordWorkspaceRootUnavailable(error, {
      activityLog: sink,
      correlationId: "ordinary-root-unavailable-0001",
    });
    const line = formatActivityLogProofLine(sink.events[0] ?? {});
    expect(expectActivityLogProof("workspace.root.denied.line", line)).toMatchObject({
      correlationId: "ordinary-root-unavailable-0001",
      errorKind,
      failureKind: code,
      frames: ["packages/keiko-server/src/grounded-qa.ts:584:9"],
      reason: "ordinary-root-unavailable",
      completeness: "complete",
      loss: "none",
    });
    expect(line).not.toContain("private-root-message-canary");
    expect(line).not.toContain("/private/work");
  });

  it("preserves the filesystem cause of a wrapped root error", () => {
    const sink = createBufferedServerLogSink();
    const error = new WorkspaceNotFoundError("root unavailable", "/private/customer/root");
    error.cause = Object.assign(new Error("private-cause-canary"), { code: "EACCES" });
    recordWorkspaceRootUnavailable(error, { activityLog: sink, correlationId: "wrapped-root" });
    const line = formatActivityLogProofLine(sink.events[0] ?? {});
    expect(expectActivityLogProof("workspace.root.denied.line", line)).toMatchObject({
      correlationId: "wrapped-root",
      errorKind: "permission-denied",
      failureKind: "EACCES",
      causeChain: ["Error"],
    });
    expect(line).not.toContain("private-cause-canary");
    expect(line).not.toContain("/private/customer/root");
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
