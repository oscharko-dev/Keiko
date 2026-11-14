import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activityLogLossCounters,
  resetActivityLogLossCountersForTests,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { savePrivateJson } from "./private-json.js";

// #4351: the DACL step of a private JSON write on Windows reports its refusal or slow run to the
// process sink. Without one the line was counted as an unwired port on every such write.
// savePrivateJson has no seam for the DACL step, so the refusal comes from a host that is not
// Windows: the platform is forced and the system tools cannot be resolved. On a real Windows host
// the DACL step succeeds and there is no refusal to observe, so the proof is skipped there.
describe.skipIf(process.platform === "win32")("savePrivateJson on Windows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetServerLogger();
    resetActivityLogLossCountersForTests();
  });

  it("writes the refusal of its DACL step to the process Activity Log, never as an unwired port", () => {
    const logs = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink: logs, level: "info" }));
    resetActivityLogLossCountersForTests();
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const dir = mkdtempSync(join(tmpdir(), "keiko-private-json-"));
    try {
      expect(() => {
        savePrivateJson(join(dir, "config.json"), { synthetic: true });
      }).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(activityLogLossCounters()["port-unwired"]).toBe(0);
    expect(logs.events.map((event) => event.op)).toContain(
      "security.windows-owner-private.refused",
    );
  });
});
