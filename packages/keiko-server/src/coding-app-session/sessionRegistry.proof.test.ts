import { expect, it } from "vitest";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createSessionRegistry } from "./sessionRegistry.js";

it.each(["missing", "malformed", "foreign", "wrong-secret"] as const)(
  "records the closed reason for a refused %s proof while a session remains registered",
  (kind) => {
    const activityLog = createBufferedServerLogSink();
    const registry = createSessionRegistry({ activityLog });
    const mint = registry.mint("private-principal");
    const presented = {
      missing: undefined,
      malformed: "bad-proof",
      foreign: `sess_${"f".repeat(24)}.synthetic-foreign`,
      "wrong-secret": `${mint.session.sessionId}.synthetic-wrong`,
    }[kind];
    expect(
      registry.verify(presented, { correlationId: "proof-observation-audit" }),
    ).toBeUndefined();
    const reason = {
      missing: "proof-missing",
      malformed: "proof-malformed",
      foreign: "session-unregistered",
      "wrong-secret": "secret-mismatch",
    }[kind];
    expect(activityLog.events).toMatchObject([
      {
        op: "coding-app-session.proof.refused",
        correlationId: "proof-observation-audit",
        extra: { reason, sessionCount: 1, registered: kind === "wrong-secret" },
      },
    ]);
    expectActivityLogProof(
      "coding-app-session.proof.refused.reason",
      formatActivityLogProofLine(activityLog.events[0] ?? {}),
    );
    const persisted = JSON.stringify(activityLog.events);
    for (const value of [
      mint.cookieToken,
      mint.session.sessionId,
      "private-principal",
      "synthetic-foreign",
      "synthetic-wrong",
    ])
      expect(persisted).not.toContain(value);
  },
);
