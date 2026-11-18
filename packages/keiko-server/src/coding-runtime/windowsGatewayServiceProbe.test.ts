import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createActivityLogSink } from "@oscharko-dev/keiko-server";
import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../../tests/support/activity-log-proof.js";
import {
  createWindowsGatewayServiceProbe,
  type RefreshingWindowsGatewayServiceProbe,
} from "./windowsGatewayServiceProbe.js";

const HELPER = "C:\\private\\customer\\keiko-runtime-supervisor.exe";
const PIN = "a".repeat(64);
const silentLog = { write: (): void => undefined };

/** Resolves once every refresh the probe has started has settled. */
async function settled(probe: RefreshingWindowsGatewayServiceProbe): Promise<void> {
  await probe.idle();
}

describe("Windows gateway service probe", () => {
  it.each([
    [0, undefined],
    [10, "gateway-service-absent"],
    [11, "gateway-service-stopped"],
    [12, "gateway-service-stale"],
    [13, "gateway-service-unknown"],
    [27, "gateway-service-unknown"],
    [null, "gateway-service-unknown"],
  ])("maps helper result %s to %s", async (exitCode, reason) => {
    const probe = createWindowsGatewayServiceProbe({
      helperPath: HELPER,
      helperSha256: PIN,
      activityLog: silentLog,
      runStatus: () => Promise.resolve(exitCode),
    });
    await settled(probe);
    expect(probe.unavailableReason()).toBe(reason);
  });

  // #4068: the helper ran through spawnSync inside the readiness route, so a slow service query
  // held the server's event loop for up to its 2 s timeout on every poll after the cache expired.
  // A read now answers at once from the last settled state and never waits for the helper.
  it("answers a read without waiting for a pending helper, failing closed before the first result", async () => {
    let finish: (code: number | null) => void = () => undefined;
    const probe = createWindowsGatewayServiceProbe({
      helperPath: HELPER,
      helperSha256: PIN,
      activityLog: silentLog,
      runStatus: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    expect(probe.unavailableReason()).toBe("gateway-service-unknown");
    finish(0);
    await settled(probe);
    expect(probe.unavailableReason()).toBeUndefined();
  });

  it("starts one refresh at a time and reads again once the cache expires", async () => {
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
        return Promise.resolve(exitCode);
      },
    });
    probe.unavailableReason();
    probe.unavailableReason();
    await settled(probe);
    expect(probe.unavailableReason()).toBe("gateway-service-absent");
    exitCode = 0;
    time += 2_999;
    expect(probe.unavailableReason()).toBe("gateway-service-absent");
    await settled(probe);
    expect(probe.unavailableReason()).toBe("gateway-service-absent");
    time += 1;
    expect(probe.unavailableReason()).toBe("gateway-service-absent");
    await settled(probe);
    expect(probe.unavailableReason()).toBeUndefined();
    expect(calls).toEqual([
      [HELPER, PIN],
      [HELPER, PIN],
    ]);
  });

  it("treats a rejected helper run as an unknown state", async () => {
    const probe = createWindowsGatewayServiceProbe({
      helperPath: HELPER,
      helperSha256: PIN,
      activityLog: silentLog,
      runStatus: () => Promise.reject(new Error("spawn failed")),
    });
    await settled(probe);
    expect(probe.unavailableReason()).toBe("gateway-service-unknown");
  });

  it("records one body-free line per state change through the real sink", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-gateway-probe-"));
    let time = 0;
    const results = [10, 10, 0];
    const sink = createActivityLogSink(root);
    try {
      const probe = createWindowsGatewayServiceProbe({
        helperPath: HELPER,
        helperSha256: PIN,
        activityLog: sink,
        evidenceClass: "functional-not-platform-qualified",
        origin: "portable-release",
        now: () => time,
        runStatus: () => Promise.resolve(results.shift() ?? 0),
      });
      for (let read = 0; read < 3; read++) {
        probe.unavailableReason();
        await settled(probe);
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
      ).toMatchObject({
        level: "warn",
        state: "absent",
        helperSha256: PIN,
        evidenceClass: "functional-not-platform-qualified",
        origin: "portable-release",
      });
      expect(
        expectActivityLogProof(
          "coding-runtime.windows-gateway-service.real-sink-line",
          lines[1] ?? "",
        ),
      ).toMatchObject({
        level: "info",
        state: "ready",
        helperSha256: PIN,
        evidenceClass: "functional-not-platform-qualified",
        origin: "portable-release",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A sink that throws must neither reject the refresh (an unhandled rejection) nor keep the state
  // from being cached: before, the helper was spawned again on every readiness read.
  it("caches the state and survives a sink that throws, reporting the loss on the stderr channel", async () => {
    let spawns = 0;
    let clock = 0;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const probe = createWindowsGatewayServiceProbe({
        helperPath: HELPER,
        helperSha256: PIN,
        activityLog: {
          write: (): void => {
            throw new Error("sink unavailable");
          },
        },
        runStatus: () => {
          spawns += 1;
          return Promise.resolve(0);
        },
        now: () => clock,
      });
      await settled(probe);
      clock = 1;
      expect(probe.unavailableReason()).toBeUndefined();
      await settled(probe);
      expect(spawns).toBe(1);
      const notice = stderr.mock.calls.map((call) => String(call[0])).join("");
      expect(notice).toContain("coding-runtime.windows-gateway-service");
      expect(notice).not.toContain(HELPER);
    } finally {
      stderr.mockRestore();
    }
  });

  describe("Repair", () => {
    it("offers no repair without a native install port", () => {
      const probe = createWindowsGatewayServiceProbe({
        helperPath: HELPER,
        helperSha256: PIN,
        activityLog: silentLog,
        runStatus: () => Promise.resolve(10),
      });
      expect(probe.repair).toBeUndefined();
    });

    // ADR-0121 D9: an installation managed outside the app (the standalone folder package, an
    // IT-managed deployment) never installs a system service, so it offers no Repair and names the
    // missing service as one this Keiko does not set up. A ready broker is still used.
    it.each([
      [10, "gateway-service-managed-outside"],
      [11, "gateway-service-managed-outside"],
      [13, "gateway-service-managed-outside"],
      [0, undefined],
    ])(
      "managed outside the app: helper result %s answers %s without Repair",
      async (exitCode, reason) => {
        const runInstall = vi.fn(() => Promise.resolve(0));
        const probe = createWindowsGatewayServiceProbe({
          helperPath: HELPER,
          helperSha256: PIN,
          activityLog: silentLog,
          runStatus: () => Promise.resolve(exitCode),
          runInstall,
          managedOutsideApp: true,
        });
        await settled(probe);
        expect(probe.unavailableReason()).toBe(reason);
        expect(probe.repair).toBeUndefined();
        expect(runInstall).not.toHaveBeenCalled();
      },
    );

    it("keeps Repair for an installation Keiko manages itself", async () => {
      const probe = createWindowsGatewayServiceProbe({
        helperPath: HELPER,
        helperSha256: PIN,
        activityLog: silentLog,
        runStatus: () => Promise.resolve(10),
        runInstall: () => Promise.resolve(0),
        managedOutsideApp: false,
      });
      await settled(probe);
      expect(probe.unavailableReason()).toBe("gateway-service-absent");
      expect(probe.repair).toBeTypeOf("function");
    });

    it("runs the native install with the pin and answers from a fresh status", async () => {
      const statuses = [10, 0];
      const installs: string[][] = [];
      const probe = createWindowsGatewayServiceProbe({
        helperPath: HELPER,
        helperSha256: PIN,
        activityLog: silentLog,
        runStatus: () => Promise.resolve(statuses.shift() ?? 0),
        runInstall: (path, pin) => {
          installs.push([path, pin]);
          return Promise.resolve(0);
        },
      });
      await settled(probe);
      expect(probe.unavailableReason()).toBe("gateway-service-absent");
      expect(await probe.repair?.("00000000-0000-4000-8000-000000000001")).toBe("ready");
      expect(installs).toEqual([[HELPER, PIN]]);
      expect(probe.unavailableReason()).toBeUndefined();
    });

    it.each([
      [20, "declined"],
      [24, "failed"],
      [10, "failed"],
      [99, "failed"],
      [null, "failed"],
    ] as const)("maps install result %s to %s", async (exitCode, outcome) => {
      const probe = createWindowsGatewayServiceProbe({
        helperPath: HELPER,
        helperSha256: PIN,
        activityLog: silentLog,
        runStatus: () => Promise.resolve(10),
        runInstall: () => Promise.resolve(exitCode),
      });
      expect(await probe.repair?.("00000000-0000-4000-8000-000000000001")).toBe(outcome);
    });

    it("answers busy while a repair waits for Windows approval", async () => {
      let approve: (code: number | null) => void = () => undefined;
      const probe = createWindowsGatewayServiceProbe({
        helperPath: HELPER,
        helperSha256: PIN,
        activityLog: silentLog,
        runStatus: () => Promise.resolve(10),
        runInstall: () =>
          new Promise((resolve) => {
            approve = resolve;
          }),
      });
      const first = probe.repair?.("00000000-0000-4000-8000-000000000001");
      expect(await probe.repair?.("00000000-0000-4000-8000-000000000002")).toBe("busy");
      approve(0);
      expect(await first).toBe("ready");
    });

    it("persists a body-free repair line under the request correlation", async () => {
      const root = mkdtempSync(join(tmpdir(), "keiko-gateway-repair-"));
      const sink = createActivityLogSink(root);
      try {
        const results = [20, 25];
        const probe = createWindowsGatewayServiceProbe({
          helperPath: HELPER,
          helperSha256: PIN,
          activityLog: sink,
          runStatus: () => Promise.resolve(10),
          runInstall: () => Promise.resolve(results.shift() ?? 0),
        });
        await probe.repair?.("00000000-0000-4000-8000-000000000003");
        await probe.repair?.("00000000-0000-4000-8000-000000000004");
        const raw = readPersistedActivityLog(root);
        expect(raw).not.toContain("customer");
        const [declined, failed] = persistedActivityLogLines(
          raw,
          "coding-runtime.windows-gateway-service.repair",
        );
        expect(
          expectActivityLogProof(
            "coding-runtime.windows-gateway-service.repair.real-sink-line",
            declined ?? "",
          ),
        ).toMatchObject({
          level: "info",
          correlationId: "00000000-0000-4000-8000-000000000003",
          outcome: "declined",
          helperSha256: PIN,
        });
        expect(
          expectActivityLogProof(
            "coding-runtime.windows-gateway-service.repair.real-sink-line",
            failed ?? "",
          ),
        ).toMatchObject({
          level: "warn",
          errorKind: "unavailable",
          outcome: "failed",
          exitClass: "native-failure",
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
