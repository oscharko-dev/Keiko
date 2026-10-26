import { assert, describe, expect, it } from "vitest";
import type { AtlassianCredentialMetadata } from "@oscharko-dev/keiko-connectors";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import { recordCredentialCreated, recordConnectionCheck } from "./credentialActivity.js";

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
    const proof = expectActivityLogProof(
      "atlassian.credential.created.line",
      formatActivityLogProofLine(event),
    );
    expect(proof).toMatchObject({
      correlationId: "credential-create-fixture",
      status: 200,
      provider: "jira",
      completeness: "complete",
      loss: "none",
    });
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
