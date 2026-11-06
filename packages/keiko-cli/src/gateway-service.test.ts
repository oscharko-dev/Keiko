import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createActivityLogSink } from "@oscharko-dev/keiko-server";
import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";
import {
  runGatewayServiceCli,
  type GatewayServiceCliDeps,
  type WindowsGatewayHelper,
} from "./gateway-service.js";
import type { CliIo } from "./runner.js";

const PIN = "a".repeat(64);
const HELPER = "C:\\private\\customer\\keiko-runtime-supervisor.exe";

function makeIo(): { io: CliIo; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return {
    io: {
      out: (text: string): void => {
        out += text;
      },
      err: (text: string): void => {
        err += text;
      },
    },
    out: () => out,
    err: () => err,
  };
}

function deps(exitCode: number | undefined, calls: string[][] = []): GatewayServiceCliDeps {
  return {
    platform: "win32",
    resolveHelper: (): Promise<WindowsGatewayHelper> =>
      Promise.resolve({ helperPath: HELPER, helperSha256: PIN }),
    runHelper: (_path, args): Promise<number> => {
      calls.push([...args]);
      return exitCode === undefined
        ? Promise.reject(new Error(`spawn failed for ${HELPER}`))
        : Promise.resolve(exitCode);
    },
  };
}

describe("keiko gateway-service", () => {
  it.each([
    ["status", ["--gateway-service-status", PIN]],
    ["install", ["--gateway-service-install", PIN]],
    ["repair", ["--gateway-service-install", PIN]],
  ])("%s passes only the fixed flag and the approved pin to the helper", async (action, args) => {
    const calls: string[][] = [];
    const { io } = makeIo();
    expect(await runGatewayServiceCli([action], io, {}, deps(0, calls))).toBe(0);
    expect(calls).toEqual([args]);
  });

  it("removes the service without a pin and treats an absent service as success", async () => {
    const calls: string[][] = [];
    const { io } = makeIo();
    expect(await runGatewayServiceCli(["uninstall"], io, {}, deps(10, calls))).toBe(0);
    expect(calls).toEqual([["--gateway-service-uninstall"]]);
  });

  it.each([
    [10, "keiko gateway-service install"],
    [11, "keiko gateway-service repair"],
    [12, "keiko gateway-service repair"],
    [13, "could not be determined"],
  ])("status %i reports not ready and names the next step", async (exitCode, text) => {
    const { io, out } = makeIo();
    expect(await runGatewayServiceCli(["status"], io, {}, deps(exitCode))).toBe(1);
    expect(out()).toContain(text);
  });

  it.each([
    [20, "declined"],
    [21, "does not match"],
    [22, "not safe"],
    [23, "could not be copied"],
    [24, "Service Control Manager"],
    [25, "did not start"],
    [26, "nothing was removed"],
    [27, "rejected"],
    [99, "unexpected result"],
  ])("install result %i fails closed with a plain reason", async (exitCode, text) => {
    const { io, err } = makeIo();
    expect(await runGatewayServiceCli(["install"], io, {}, deps(exitCode))).toBe(1);
    expect(err()).toContain(text);
  });

  it("does not report a repair as complete when the broker is only absent", async () => {
    const { io } = makeIo();
    expect(await runGatewayServiceCli(["repair"], io, {}, deps(10))).toBe(1);
  });

  it("refuses an unqualified package before any helper or elevation runs", async () => {
    const calls: string[][] = [];
    const { io, err } = makeIo();
    const code = await runGatewayServiceCli(
      ["install"],
      io,
      {},
      {
        ...deps(0, calls),
        resolveHelper: () => Promise.resolve(undefined),
      },
    );
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(err()).toContain("release-qualified");
  });

  it("refuses other platforms without resolving a helper", async () => {
    const { io, err } = makeIo();
    const code = await runGatewayServiceCli(
      ["status"],
      io,
      {},
      {
        platform: "darwin",
        resolveHelper: () => Promise.reject(new Error("must not resolve")),
      },
    );
    expect(code).toBe(1);
    expect(err()).toContain("only on Windows");
  });

  it("answers help and usage without side effects", async () => {
    const help = makeIo();
    expect(await runGatewayServiceCli(["--help"], help.io, {}, deps(0))).toBe(0);
    expect(help.out()).toContain("Usage:");
    expect(help.out()).toContain("--dev-lane");
    for (const rest of [
      [],
      ["bogus"],
      ["install", "extra"],
      ["--dev-lane"],
      ["install", "--dev-lane", "--dev-lane"],
    ]) {
      const usage = makeIo();
      expect(await runGatewayServiceCli(rest, usage.io, {}, deps(0))).toBe(2);
    }
  });

  // #4068 (ADR-0043 D19): a Windows dev checkout installs the same broker with its own supervisor.
  describe("--dev-lane", () => {
    it.each([
      [
        ["install", "--dev-lane"],
        ["--gateway-service-install", PIN],
      ],
      [
        ["--dev-lane", "status"],
        ["--gateway-service-status", PIN],
      ],
    ])("%j asks for the dev checkout's helper and passes its pin", async (rest, args) => {
      const calls: string[][] = [];
      const lanes: string[] = [];
      const code = await runGatewayServiceCli(
        rest,
        makeIo().io,
        {},
        {
          ...deps(0, calls),
          resolveHelper: (_env, lane) => {
            lanes.push(lane);
            return Promise.resolve({ helperPath: HELPER, helperSha256: PIN });
          },
        },
      );
      expect(code).toBe(0);
      expect(lanes).toEqual(["dev-checkout"]);
      expect(calls).toEqual([args]);
    });

    it("asks for the release helper without the flag", async () => {
      const lanes: string[] = [];
      await runGatewayServiceCli(
        ["status"],
        makeIo().io,
        {},
        {
          ...deps(0),
          resolveHelper: (_env, lane) => {
            lanes.push(lane);
            return Promise.resolve({ helperPath: HELPER, helperSha256: PIN });
          },
        },
      );
      expect(lanes).toEqual(["release-qualified"]);
    });

    it("refuses an unverified checkout before any helper or elevation runs", async () => {
      const calls: string[][] = [];
      const { io, err } = makeIo();
      const code = await runGatewayServiceCli(
        ["install", "--dev-lane"],
        io,
        {},
        {
          ...deps(0, calls),
          resolveHelper: () => Promise.resolve(undefined),
        },
      );
      expect(code).toBe(1);
      expect(calls).toEqual([]);
      expect(err()).toContain("npm run dev:coding-runtime:stage");
      expect(err()).not.toContain("release-qualified");
    });

    it.each([
      [10, "keiko gateway-service install --dev-lane"],
      [11, "keiko gateway-service repair --dev-lane"],
      [12, "keiko gateway-service repair --dev-lane"],
    ])("status %i names the dev-lane command", async (exitCode, text) => {
      const { io, out } = makeIo();
      expect(await runGatewayServiceCli(["status", "--dev-lane"], io, {}, deps(exitCode))).toBe(1);
      expect(out()).toContain(text);
    });
  });

  it("persists body-free lifecycle evidence through the real sink", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-gateway-service-"));
    const env = { KEIKO_STATE_DIR: root };
    const securityLogSinkFactory = (stateDir: string): ReturnType<typeof createActivityLogSink> =>
      createActivityLogSink(stateDir);
    try {
      await runGatewayServiceCli(["status"], makeIo().io, env, {
        ...deps(12),
        securityLogSinkFactory,
      });
      await runGatewayServiceCli(["install"], makeIo().io, env, {
        ...deps(20),
        securityLogSinkFactory,
      });
      await runGatewayServiceCli(["install"], makeIo().io, env, {
        ...deps(undefined),
        securityLogSinkFactory,
      });
      await runGatewayServiceCli(["install", "--dev-lane"], makeIo().io, env, {
        ...deps(0),
        resolveHelper: () => Promise.resolve(undefined),
        securityLogSinkFactory,
      });
      const raw = readPersistedActivityLog(root);
      expect(raw).not.toContain("customer");
      const [started] = persistedActivityLogLines(raw, "cli.gateway-service.started");
      expect(
        expectActivityLogProof("cli.gateway-service.started.real-sink-line", started ?? ""),
      ).toMatchObject({ action: "status", lane: "release-qualified" });
      const [completed] = persistedActivityLogLines(raw, "cli.gateway-service.completed");
      expect(
        expectActivityLogProof("cli.gateway-service.completed.real-sink-line", completed ?? ""),
      ).toMatchObject({ action: "status", lane: "release-qualified", state: "image-mismatch" });
      const failed = persistedActivityLogLines(raw, "cli.gateway-service.failed");
      expect(
        expectActivityLogProof("cli.gateway-service.failed.real-sink-line", failed[0] ?? ""),
      ).toMatchObject({
        level: "error",
        errorKind: "cancelled",
        action: "install",
        lane: "release-qualified",
        reason: "elevation-declined",
      });
      expect(
        expectActivityLogProof("cli.gateway-service.failed.real-sink-line", failed[1] ?? ""),
      ).toMatchObject({ errorKind: "unavailable", reason: "helper-unavailable" });
      expect(
        expectActivityLogProof("cli.gateway-service.failed.real-sink-line", failed[2] ?? ""),
      ).toMatchObject({
        errorKind: "validation-failed",
        action: "install",
        lane: "dev-checkout",
        reason: "dev-checkout-unverified",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
