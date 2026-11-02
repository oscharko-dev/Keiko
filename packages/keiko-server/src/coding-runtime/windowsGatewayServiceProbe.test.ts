import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createActivityLogSink } from "@oscharko-dev/keiko-server";
import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../../tests/support/activity-log-proof.js";
import { createWindowsGatewayServiceProbe } from "./windowsGatewayServiceProbe.js";

const HELPER = "C:\\private\\customer\\keiko-runtime-supervisor.exe";
const PIN = "a".repeat(64);
const silentLog = { write: (): void => undefined };

describe("Windows gateway service probe", () => {
  it.each([
    [0, undefined],
    [10, "gateway-service-absent"],
    [11, "gateway-service-stopped"],
    [12, "gateway-service-stale"],
    [13, "gateway-service-unknown"],
    [27, "gateway-service-unknown"],
    [null, "gateway-service-unknown"],
  ])("maps helper result %s to %s", (exitCode, reason) => {
    const probe = createWindowsGatewayServiceProbe({
      helperPath: HELPER,
      helperSha256: PIN,
      activityLog: silentLog,
      runStatus: () => exitCode,
    });
    expect(probe.unavailableReason()).toBe(reason);
  });

  it("passes the helper path and pin and reads again once the cache expires", () => {
    const calls: string[][] = [];
    let time = 1_000;
    let exitCode = 10;
    const probe = createWindowsGatewayServiceProbe({
      helperPath: HELPER,
      helperSha256: PIN,
      activityLog: silentLog,
      now: () => time,
      runStatus: (path, pin) => {
        calls.push([path, pin]);
        return exitCode;
      },
    });
    expect(probe.unavailableReason()).toBe("gateway-service-absent");
    exitCode = 0;
    time += 2_999;
    expect(probe.unavailableReason()).toBe("gateway-service-absent");
    time += 1;
    expect(probe.unavailableReason()).toBeUndefined();
    expect(calls).toEqual([
      [HELPER, PIN],
      [HELPER, PIN],
    ]);
  });

  it("records one body-free line per state change through the real sink", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-gateway-probe-"));
    let time = 0;
    const results = [10, 10, 0];
    const sink = createActivityLogSink(root);
    try {
      const probe = createWindowsGatewayServiceProbe({
        helperPath: HELPER,
        helperSha256: PIN,
        activityLog: sink,
        now: () => time,
        runStatus: () => results.shift() ?? 0,
      });
      for (let read = 0; read < 3; read++) {
        probe.unavailableReason();
        time += 5_000;
      }
      const raw = readPersistedActivityLog(root);
      expect(raw).not.toContain("customer");
      const lines = persistedActivityLogLines(raw, "coding-runtime.windows-gateway-service");
      expect(lines).toHaveLength(2);
      expect(
        expectActivityLogProof(
          "coding-runtime.windows-gateway-service.real-sink-line",
          lines[0] ?? "",
        ),
      ).toMatchObject({ level: "warn", state: "absent" });
      expect(
        expectActivityLogProof(
          "coding-runtime.windows-gateway-service.real-sink-line",
          lines[1] ?? "",
        ),
      ).toMatchObject({ level: "info", state: "ready" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
