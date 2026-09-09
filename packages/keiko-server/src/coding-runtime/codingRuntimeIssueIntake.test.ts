// #3390: the orchestrator's admission step for a coding-run issue binding. The issue attachment
// (the untrusted issue text rendered into the first turn) is transient — held only in memory from
// "Use this issue" — while the issue binding itself is durable (persisted on the run ledger). A
// retry or a plain start against an acknowledged recovery-required predecessor never re-supplies a
// fresh pasted reference, so a run that starts with a durable binding but no transient attachment
// must re-resolve the attachment through the SAME authorized reader/intake path the preview uses
// (`buildContext`, keyed off the durable binding's own issue number) before the first turn — never
// silently start context-free, and never blanket-refuse a still-readable issue either.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  CodingWorkbenchIssueBinding,
  CodingWorkbenchRuntimeStartRequest,
} from "@oscharko-dev/keiko-contracts";
import type { ActiveWorkspaceView } from "../task-workspace/types.js";
import { deriveRepositoryId } from "../task-workspace/naming.js";
import type { ServerLogEvent, ServerLogSink } from "../observability/server-log.js";
import { githubIssueReaderRepositoryId } from "../coding-context/githubIssueReaderAuthorization.js";
import {
  admitCodingRuntimeIssue,
  type CodingRuntimeIssueAttachment,
  type CodingRuntimeIssueIntake,
} from "./codingRuntimeIssueIntake.js";

const REPOSITORY_ROOT = realpathSync(process.cwd());
const REPOSITORY_ID = githubIssueReaderRepositoryId(REPOSITORY_ROOT);
if (REPOSITORY_ID === undefined) throw new Error("Expected repository fixture identity");

const ISSUE_BINDING: CodingWorkbenchIssueBinding = {
  schemaVersion: "1",
  repositoryId: REPOSITORY_ID,
  remoteDigest: "1".repeat(64),
  issueNumber: 3390,
  issueIdDigest: "2".repeat(64),
  defaultBaseRef: "dev",
  contentRevisionDigest: "3".repeat(64),
  bindingDigest: "4".repeat(64),
};

const ISSUE_TITLE = "Issue attachment must survive a server restart";
const ISSUE_ATTACHMENT: CodingRuntimeIssueAttachment = {
  issueNumber: 3390,
  itemCount: 1,
  byteCount: 64,
  text: `[untrusted issue context] ${ISSUE_TITLE}`,
};

const REQUEST: CodingWorkbenchRuntimeStartRequest = {
  requestId: "request-1",
  taskIntent: "fix the bounded issue",
  requestedMode: "supervised-coding",
};

const ACTIVE: ActiveWorkspaceView = {
  instance: {
    repositoryId: REPOSITORY_ID,
    repositoryRoot: REPOSITORY_ROOT,
    baseBranch: "dev",
  },
} as unknown as ActiveWorkspaceView;

function intake(
  overrides: Partial<{
    readonly resolve: CodingRuntimeIssueIntake["resolve"];
    readonly buildContext: CodingRuntimeIssueIntake["buildContext"];
  }> = {},
): CodingRuntimeIssueIntake {
  const defaultResolve: CodingRuntimeIssueIntake["resolve"] = () =>
    Promise.resolve({ ok: true, binding: ISSUE_BINDING });
  const defaultBuildContext: CodingRuntimeIssueIntake["buildContext"] = () =>
    Promise.resolve({ ok: true, attachment: ISSUE_ATTACHMENT });
  return {
    resolve: vi.fn(overrides.resolve ?? defaultResolve),
    buildContext: vi.fn(overrides.buildContext ?? defaultBuildContext),
  };
}

function captureActivityLog(): {
  readonly activityLog: ServerLogSink;
  readonly records: ServerLogEvent[];
} {
  const records: ServerLogEvent[] = [];
  return { activityLog: { write: (event) => void records.push(event) }, records };
}

describe("admitCodingRuntimeIssue — durable-binding reattach (#3390)", () => {
  it("re-resolves and attaches through the intake when no fresh reference is pasted but a durable binding exists", async () => {
    const port = intake();
    const captured = captureActivityLog();

    const result = await admitCodingRuntimeIssue({
      request: { ...REQUEST, issueRef: undefined },
      active: ACTIVE,
      runId: "run-2",
      priorBinding: ISSUE_BINDING,
      intake: port,
      activityLog: captured.activityLog,
    });

    expect(result).toEqual({ ok: true, binding: ISSUE_BINDING, attachment: ISSUE_ATTACHMENT });
    // The durable binding's own identity, never a fresh paste — resolve() is never called.
    expect(port.resolve).not.toHaveBeenCalled();
    expect(port.buildContext).toHaveBeenCalledWith({
      runId: "run-2",
      repositoryRoot: REPOSITORY_ROOT,
      binding: ISSUE_BINDING,
      effectiveMode: "supervised-coding",
      correlationId: "run-2",
    });
    expect(
      captured.records.some((event) => event.op === "coding-runtime.run.issue-binding-refused"),
    ).toBe(false);
  });

  it("refuses with the closed issue-context-unavailable code when re-resolution fails, logging body-free", async () => {
    const port = intake({
      buildContext: () => Promise.resolve({ ok: false, failure: "issue-unavailable" }),
    });
    const captured = captureActivityLog();

    const result = await admitCodingRuntimeIssue({
      request: { ...REQUEST, issueRef: undefined },
      active: ACTIVE,
      runId: "run-2",
      priorBinding: ISSUE_BINDING,
      intake: port,
      activityLog: captured.activityLog,
    });

    expect(result).toEqual({
      ok: false,
      failureCode: "issue-context-unavailable",
      issueBindingFailure: "issue-unavailable",
    });
    const refusal = captured.records.find(
      (event) => event.op === "coding-runtime.run.issue-binding-refused",
    );
    expect(refusal).toMatchObject({
      extra: { runId: "run-2", stage: "reattach", issueBindingFailure: "issue-unavailable" },
    });
    expect(JSON.stringify(captured.records)).not.toContain(ISSUE_TITLE);
  });

  it("refuses with the closed code when the intake throws during re-resolution", async () => {
    const port = intake({
      buildContext: () => Promise.reject(new Error("provider failure")),
    });
    const captured = captureActivityLog();

    const result = await admitCodingRuntimeIssue({
      request: { ...REQUEST, issueRef: undefined },
      active: ACTIVE,
      runId: "run-2",
      priorBinding: ISSUE_BINDING,
      intake: port,
      activityLog: captured.activityLog,
    });

    expect(result).toEqual({
      ok: false,
      failureCode: "issue-context-unavailable",
      issueBindingFailure: "issue-unavailable",
    });
  });

  it("refuses closed when no intake port is wired at all (no attempt, no silent start)", async () => {
    const result = await admitCodingRuntimeIssue({
      request: { ...REQUEST, issueRef: undefined },
      active: ACTIVE,
      runId: "run-2",
      priorBinding: ISSUE_BINDING,
    });

    expect(result).toEqual({ ok: false, failureCode: "issue-context-unavailable" });
  });

  it("refuses the reattach when the active workspace no longer matches the durable binding's repository", async () => {
    const port = intake();

    const result = await admitCodingRuntimeIssue({
      request: { ...REQUEST, issueRef: undefined },
      active: {
        instance: {
          repositoryId: deriveRepositoryId(tmpdir()),
          repositoryRoot: tmpdir(),
          baseBranch: "dev",
        },
      } as unknown as ActiveWorkspaceView,
      runId: "run-2",
      priorBinding: ISSUE_BINDING,
      intake: port,
    });

    expect(result).toEqual({
      ok: false,
      failureCode: "invalid-intent",
      issueBindingFailure: "repository-mismatch",
    });
    expect(port.buildContext).not.toHaveBeenCalled();
  });

  it("accepts a canonical issue binding when the active workspace root is a symlink", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "keiko-issue-intake-symlink-"));
    const repositoryRoot = join(fixtureRoot, "repository");
    const aliasRoot = join(fixtureRoot, "alias");
    mkdirSync(repositoryRoot);
    symlinkSync(repositoryRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    const canonicalRepositoryId = githubIssueReaderRepositoryId(aliasRoot);
    if (canonicalRepositoryId === undefined) throw new Error("Expected canonical repository id");
    const binding = { ...ISSUE_BINDING, repositoryId: canonicalRepositoryId };
    const port = intake({ resolve: () => Promise.resolve({ ok: true, binding }) });

    try {
      const result = await admitCodingRuntimeIssue({
        request: { ...REQUEST, issueRef: "3390" },
        active: {
          instance: {
            repositoryId: deriveRepositoryId(aliasRoot),
            repositoryRoot: aliasRoot,
            baseBranch: "dev",
          },
        } as unknown as ActiveWorkspaceView,
        runId: "run-symlink",
        intake: port,
      });

      expect(result).toEqual({ ok: true, binding, attachment: ISSUE_ATTACHMENT });
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("happy path unchanged: no issueRef and no prior binding starts with no issue involved", async () => {
    const result = await admitCodingRuntimeIssue({
      request: { ...REQUEST, issueRef: undefined },
      active: ACTIVE,
      runId: "run-1",
    });

    expect(result).toEqual({ ok: true });
  });

  it("happy path unchanged: a freshly pasted reference still resolves and attaches normally", async () => {
    const port = intake();

    const result = await admitCodingRuntimeIssue({
      request: { ...REQUEST, issueRef: "https://github.com/oscharko-dev/Keiko/issues/3390" },
      active: ACTIVE,
      runId: "run-1",
      intake: port,
    });

    expect(result).toEqual({ ok: true, binding: ISSUE_BINDING, attachment: ISSUE_ATTACHMENT });
    expect(port.resolve).toHaveBeenCalledTimes(1);
  });
});
