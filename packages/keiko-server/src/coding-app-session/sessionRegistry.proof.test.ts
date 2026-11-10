import { expect, it } from "vitest";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createSessionRegistry } from "./sessionRegistry.js";

it.each(["missing", "malformed", "foreign", "wrong-secret"] as const)(
  "records no line for a caller-controlled %s proof while a session remains registered",
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
    // Any page that reaches the loopback server can repeat these without limit.
    for (let index = 0; index < 1_000; index += 1)
      expect(
        registry.verify(presented, { correlationId: "proof-observation-audit" }),
      ).toBeUndefined();
    expect(activityLog.events).toEqual([]);
    expect(registry.verify(mint.cookieToken)).toBeDefined();
  },
);

it("records the closed reason once when a registered session's proof has expired", () => {
  const activityLog = createBufferedServerLogSink();
  let now = 0;
  const registry = createSessionRegistry({ activityLog, now: () => now, absoluteTtlMs: 10_000 });
  const mint = registry.mint("private-principal");
  now = 10_000;
  for (let index = 0; index < 3; index += 1)
    expect(
      registry.verify(mint.cookieToken, { correlationId: "proof-observation-audit" }),
    ).toBeUndefined();
  const refused = activityLog.events.filter(
    (event) => event.op === "coding-app-session.proof.refused",
  );
  // The expiry removes the session, so later attempts are caller-controlled and unrecorded.
  expect(refused).toMatchObject([
    {
      correlationId: "proof-observation-audit",
      extra: { reason: "lifetime", registered: true },
    },
  ]);
  expectActivityLogProof(
    "coding-app-session.proof.refused.reason",
    formatActivityLogProofLine(refused[0] ?? {}),
  );
  const persisted = JSON.stringify(activityLog.events);
  for (const value of [mint.cookieToken, mint.session.sessionId, "private-principal"])
    expect(persisted).not.toContain(value);
});
