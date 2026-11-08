import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, expect, it, vi } from "vitest";
import type { AtlassianCredentialMetadata } from "@oscharko-dev/keiko-connectors";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../../tests/support/activity-log-proof.js";
import { defaultServerDiagnosticSink, type ServerDiagnosticRecord } from "../diagnostics-log.js";
import { closeFileServerLogSinks } from "../observability/index.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { privateJiraCustodyFixture } from "../../../../tests/support/jira-private-custody-fixture.js";
import {
  cancelUnclaimedJiraHumanInput,
  recordCredentialCreated,
  recordConnectionCheck,
  recordCredentialUpdated,
  recordJiraHumanInput,
  reportJiraHumanInputCleanupFailure,
} from "./credentialActivity.js";

const metadata: AtlassianCredentialMetadata = {
  schemaVersion: "1",
  authRef: "atlassian-cred:AAAAAAAAAAAAAAAAAAAAAA",
  provider: "jira",
  displayName: "Synthetic",
  baseUrl: "https://fixture.example",
  authScheme: "basic-api-token",
  createdAt: 1,
};

describe("credential creation activity", () => {
  it.each([undefined, "private-submit-proof", "unknown-correlation-id", "invalid parent"])(
    "never invents a Submit parent or a self-parent for %s",
    (operationCorrelationId) => {
      const lines: string[] = [];
      recordJiraHumanInput(
        {
          activityLog: {
            write: (event): void => {
              lines.push(formatActivityLogProofLine(event));
            },
          },
        },
        "private-submit-proof",
        "provided",
        operationCorrelationId,
      );
      expect(lines).toHaveLength(1);
      const proof = expectActivityLogProof("atlassian.jira.human-input.line", lines[0] ?? "");
      expect(proof).toMatchObject({ correlationId: "private-submit-proof", phase: "provided" });
      expect(proof).not.toHaveProperty("parentCorrelationId");
    },
  );
  it.each(["bound-operation", "legacy"] as const)(
    "persists private-input cleanup failure under its %s correlation without leaking custody context",
    (kind) => {
      const f = privateJiraCustodyFixture("jira.login");
      const operationCorrelationId = "private-cleanup-operation-proof";
      const binding =
        kind === "bound-operation" ? { ...f.binding, operationCorrelationId } : f.binding;
      const directory = mkdtempSync(join(tmpdir(), "keiko-input-cleanup-correlation-"));
      const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.stubEnv("KEIKO_STATE_DIR", directory);
      try {
        reportJiraHumanInputCleanupFailure(
          { diagnostics: defaultServerDiagnosticSink },
          binding,
          new Error("synthetic private password or cookie material"),
        );
        const lines = persistedActivityLogLines(
          readPersistedActivityLog(directory),
          "server.diagnostic.failure",
        );
        expect(lines).toHaveLength(1);
        const proof = expectActivityLogProof(
          "server.diagnostic.failure.activity-log-line",
          lines[0] ?? "",
        );
        expect(proof).toMatchObject({
          correlationId:
            kind === "bound-operation" ? operationCorrelationId : UNKNOWN_CORRELATION_ID,
          diagnosticOperation: "atlassian.jira.human-input",
          source: "atlassian.credential-activity.human-input",
        });
        expect(proof).not.toHaveProperty("parentCorrelationId");
        for (const value of [
          binding.authority.runId,
          binding.authRef,
          binding.actorUserKey,
          binding.actorUsername,
          binding.argumentsDigest,
          "synthetic private password or cookie material",
        ])
          expect(lines.join("\n")).not.toContain(value);
      } finally {
        closeFileServerLogSinks();
        stderr.mockRestore();
        vi.unstubAllEnvs();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  it("preserves an acknowledged outcome when input cleanup fails and exposes no private failure text", () => {
    const f = privateJiraCustodyFixture("jira.login");
    const view = f.inputs.prepare(f.binding);
    const diagnostics: ServerDiagnosticRecord[] = [];
    const privateText = "synthetic private cleanup value";
    const outcome = { ok: false, reason: "unavailable", receipt: { userKey: "synthetic-actor" } };
    const finish = () => {
      try {
        return outcome;
      } finally {
        cancelUnclaimedJiraHumanInput(
          {
            custody: {
              ...f.custody,
              humanInputs: {
                ...f.inputs,
                cancel: () => {
                  throw new Error(privateText);
                },
              },
            },
            diagnostics: {
              record: (record) => {
                diagnostics.push(record);
              },
            },
          },
          view.requestId,
          f.binding,
        );
      }
    };
    expect(finish()).toBe(outcome);
    expect(diagnostics).toMatchObject([{ message: "jira-private-input-cleanup-failed" }]);
    expect(JSON.stringify(diagnostics)).not.toContain(privateText);
    expect(JSON.stringify(diagnostics)).not.toContain(f.binding.authRef);
  });
  it("does not turn an applied update into a retryable failure when logging fails", () => {
    const diagnostics: ServerDiagnosticRecord[] = [];
    expect(() => {
      recordCredentialUpdated(
        {
          activityLog: {
            write: (): never => {
              throw new Error("synthetic sink failure");
            },
          },
          diagnostics: {
            record: (record): void => {
              diagnostics.push(record);
            },
          },
        },
        "credential-update-fixture",
        2,
        "replace-token",
      );
    }).not.toThrow();
    expect(diagnostics).toMatchObject([
      {
        correlationId: "credential-update-fixture",
        message: "atlassian-credential-updated-activity-log-failed",
      },
    ]);
  });

  it.each(["ok", "auth-failed", "invalid-response", "tls-failed", "sync-unsupported"] as const)(
    "records the closed connection outcome %s",
    (result) => {
      let event: ServerLogEvent | undefined;
      recordConnectionCheck(
        {
          activityLog: {
            write: (value): void => {
              event = value;
            },
          },
        },
        "connection-check-fixture",
        result,
      );
      assert(event !== undefined);
      const proof = expectActivityLogProof(
        "atlassian.connection.checked.line",
        formatActivityLogProofLine(event),
      );
      expect(proof).toMatchObject({
        correlationId: "connection-check-fixture",
        outcome: result,
        action: result === "sync-unsupported" ? "sync" : "verify",
        completeness: "complete",
        loss: "none",
      });
    },
  );
  it("records the committed outcome without credential identity or content", () => {
    let event: ServerLogEvent | undefined;
    recordCredentialCreated(
      {
        activityLog: {
          write: (value): void => {
            event = value;
          },
        },
      },
      metadata,
      "credential-create-fixture",
    );
    assert(event !== undefined);
    const line = formatActivityLogProofLine(event);
    const proof = expectActivityLogProof("atlassian.credential.created.line", line);
    expect(proof).toMatchObject({
      correlationId: "credential-create-fixture",
      status: 200,
      provider: "jira",
      authScheme: "basic-api-token",
      completeness: "complete",
      loss: "none",
    });
    expect(analyzeLogText(line).timelines).toMatchObject([
      {
        correlationId: "credential-create-fixture",
        lines: [
          {
            op: "atlassian.credential.created",
            extra: { provider: "jira", authScheme: "basic-api-token" },
          },
        ],
      },
    ]);
    for (const value of [metadata.baseUrl, metadata.authRef, metadata.displayName])
      expect(JSON.stringify(proof)).not.toContain(value);
  });

  it("preserves the committed result and reports a body-free diagnostic if the sink fails", () => {
    const diagnostics: ServerDiagnosticRecord[] = [];
    expect(() => {
      recordCredentialCreated(
        {
          activityLog: {
            write: (): never => {
              throw new Error("synthetic sink failure");
            },
          },
          diagnostics: {
            record: (record): void => {
              diagnostics.push(record);
            },
          },
        },
        metadata,
        "credential-create-fixture",
      );
    }).not.toThrow();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      correlationId: "credential-create-fixture",
      message: "atlassian-credential-created-activity-log-failed",
    });
  });
});
