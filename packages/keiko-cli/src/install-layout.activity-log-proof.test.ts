// Activity Log proof for `cli.install-layout.normalized` (#3532 proof backlog, partition p4-cli).
//
// `installLayoutOverrideActivityLogEvent` is the registered emitter
// (`install-layout.installLayoutOverrideActivityLogEvent`). It is driven here through
// `writeInstallLayoutOverrideEvidence`, the production caller that reads the pending override
// evidence out of the process env, builds the event, hands it to the sink, and — only once the
// sink has accepted the line — clears the two override env markers. The suffix
// `before-support-snapshot` names exactly that ordering: a caller (such as `keiko support export`)
// that snapshots the env AFTER this call must never observe a stale pending override, because the
// evidence for it has already been captured.
import { describe, expect, it } from "vitest";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import {
  INSTALL_LAYOUT_CORRELATION_ID_ENV,
  INSTALL_LAYOUT_OVERRIDES_ENV,
  writeInstallLayoutOverrideEvidence,
  type InstallLayoutNormalizedActivityLogEvent,
} from "./install-layout.js";

describe("install-layout activity log proof", () => {
  it("persists cli.install-layout.normalized before a later snapshot can observe the pending override", () => {
    const correlationId = "00000000-0000-4000-8000-000000000001";
    const env: Record<string, string | undefined> = {
      [INSTALL_LAYOUT_OVERRIDES_ENV]: "cli-bin,ui-static-root",
      [INSTALL_LAYOUT_CORRELATION_ID_ENV]: correlationId,
    };
    const events: InstallLayoutNormalizedActivityLogEvent[] = [];

    const wrote = writeInstallLayoutOverrideEvidence(
      { write: (event) => void events.push(event) },
      env,
    );

    expect(wrote).toBe(true);
    expect(events).toHaveLength(1);
    const line = formatActivityLogProofLine(events[0] ?? {});
    const record = expectActivityLogProof(
      "cli.install-layout.normalized.before-support-snapshot",
      line,
    );
    expect(record).toMatchObject({
      correlationId,
      overriddenCount: 2,
      overriddenKinds: ["cli-bin", "ui-static-root"],
    });
    // The evidence line above is what proves the override happened; the markers are cleared in the
    // SAME call, so a snapshot of this env object taken any time after `writeInstallLayoutOverrideEvidence`
    // returns can never see the pending override again.
    expect(env[INSTALL_LAYOUT_OVERRIDES_ENV]).toBeUndefined();
    expect(env[INSTALL_LAYOUT_CORRELATION_ID_ENV]).toBeUndefined();
  });
});
