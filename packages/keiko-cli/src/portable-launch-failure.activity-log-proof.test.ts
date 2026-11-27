// Activity Log proof for `portable.launch.failed` (#4358): one closed, body-free line for every
// non-zero exit of `portable launch`. The emitter runs through the real registered formatter, so
// the closed reason and note vocabularies, the error kind and the absence of any text are the
// persisted shape and not only a buffered object.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SecurityLogEvent, SecurityLogSink } from "@oscharko-dev/keiko-security";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { LAUNCH_FAILURE_REASONS } from "./launch-failure-note.js";
import { emitPortableLaunchFailed, LaunchFailureRecorder } from "./portable-launch-failure.js";

function emitted(
  reason: (typeof LAUNCH_FAILURE_REASONS)[number],
  note: "written" | "failed",
): SecurityLogEvent[] {
  const events: SecurityLogEvent[] = [];
  const sink: SecurityLogSink = { write: (event): void => void events.push(event) };
  emitPortableLaunchFailed(sink, reason, note);
  return events;
}

describe("portable.launch.failed activity log proof", () => {
  it("persists the closed reason and whether the launcher's note was left", () => {
    const events = emitted("port-in-use", "written");

    expect(events).toHaveLength(1);
    const line = formatActivityLogProofLine(events[0] ?? {});
    const record = expectActivityLogProof("portable.launch.failed.emitted-line", line);
    expect(record).toMatchObject({
      reason: "port-in-use",
      launcherBox: "written",
      errorKind: "conflict",
      level: "error",
    });
  });

  it("persists a state directory inside the start folder as a closed, body-free refusal", () => {
    const line = formatActivityLogProofLine(
      emitted("state-dir-in-start-folder", "not-requested" as never)[0] ?? {},
    );
    const record = expectActivityLogProof("portable.launch.failed.emitted-line", line);
    expect(record).toMatchObject({
      reason: "state-dir-in-start-folder",
      errorKind: "permission-denied",
    });
  });

  it("accepts every closed reason through the registered formatter, with a closed error kind", () => {
    for (const reason of LAUNCH_FAILURE_REASONS) {
      const events = emitted(reason, "failed");
      const line = formatActivityLogProofLine(events[0] ?? {});
      const record = expectActivityLogProof("portable.launch.failed.emitted-line", line);
      expect(record).toMatchObject({ reason, launcherBox: "failed" });
    }
  });

  // The registration lists its values literally (the generator reads them statically); the note and
  // the launcher use LAUNCH_FAILURE_REASONS. They must be one vocabulary.
  it("registers exactly the reasons the note and the launcher can carry", () => {
    const catalog = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../../../docs/observability/op-catalog.generated.json", import.meta.url),
        ),
        "utf8",
      ),
    ) as unknown;
    const found: unknown[] = [];
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(visit);
      } else if (typeof node === "object" && node !== null) {
        const record = node as Record<string, unknown>;
        if (record.op === "portable.launch.failed" && record.fields !== undefined)
          found.push(record);
        Object.values(record).forEach(visit);
      }
    };
    visit(catalog);

    expect(found.length).toBeGreaterThan(0);
    const fields = (found[0] as { fields: { reason: { values: string[] } } }).fields;
    expect(fields.reason.values).toEqual([...LAUNCH_FAILURE_REASONS]);
  });

  it("keeps the first recorded reason: the earliest cause is the most specific", () => {
    const recorder = new LaunchFailureRecorder();

    recorder.record("pid-publication");
    recorder.record("health-timeout");

    expect(recorder.reason).toBe("pid-publication");
    expect(new LaunchFailureRecorder().reason).toBeUndefined();
  });
});
