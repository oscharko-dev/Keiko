import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createActivityLogSink } from "@oscharko-dev/keiko-server";
import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";
import {
  GATEWAY_SERVICE_SETUP_RECORD,
  readGatewayServiceSetupPin,
  setUpWindowsGatewayServiceForStart,
  type GatewayServiceSetupDeps,
} from "./gateway-service-setup.js";
import type { WindowsGatewayHelper } from "./gateway-service.js";
import type { CliIo } from "./runner.js";

const PIN = "a".repeat(64);
const NEXT_PIN = "b".repeat(64);
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

interface Scripted {
  readonly deps: GatewayServiceSetupDeps;
  readonly calls: string[][];
}

/** A helper whose status and install answers are scripted, in call order. */
function scripted(
  answers: readonly (number | Error)[],
  helper: WindowsGatewayHelper | null = { helperPath: HELPER, helperSha256: PIN },
): Scripted {
  const calls: string[][] = [];
  const queue = [...answers];
  return {
    calls,
    deps: {
      platform: "win32",
      resolveHelper: (): Promise<WindowsGatewayHelper | undefined> =>
        Promise.resolve(helper ?? undefined),
      runHelper: (_path, args): Promise<number> => {
        calls.push([...args]);
        const next = queue.shift();
        if (next instanceof Error) return Promise.reject(next);
        return Promise.resolve(next ?? 13);
      },
    },
  };
}

describe("automatic Windows gateway setup on start", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-gateway-setup-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  function input(env: Readonly<Record<string, string | undefined>> = {}): {
    readonly stateDir: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly io: CliIo;
    readonly sink: undefined;
  } {
    return { stateDir, env, io: makeIo().io, sink: undefined };
  }

  it("does nothing off Windows", async () => {
    const helper = scripted([0]);
    const outcome = await setUpWindowsGatewayServiceForStart(input(), {
      ...helper.deps,
      platform: "darwin",
    });
    expect(outcome).toBeUndefined();
    expect(helper.calls).toEqual([]);
  });

  it("only reads the state when the service is already ready", async () => {
    const helper = scripted([0]);
    expect(await setUpWindowsGatewayServiceForStart(input(), helper.deps)).toBe("ready");
    expect(helper.calls).toEqual([["--gateway-service-status", PIN]]);
  });

  it("installs a missing service once, with the approved pin, and remembers the attempt", async () => {
    const helper = scripted([10, 0]);
    const io = makeIo();
    const outcome = await setUpWindowsGatewayServiceForStart(
      { stateDir, env: {}, io: io.io, sink: undefined },
      helper.deps,
    );
    expect(outcome).toBe("installed");
    expect(helper.calls).toEqual([
      ["--gateway-service-status", PIN],
      ["--gateway-service-install", PIN],
    ]);
    expect(io.out()).toContain("Windows asks for approval once");
    expect(readGatewayServiceSetupPin(stateDir)).toBe(PIN);
  });

  it("does not ask again for the same helper after a declined approval", async () => {
    const first = scripted([10, 20]);
    const io = makeIo();
    expect(
      await setUpWindowsGatewayServiceForStart(
        { stateDir, env: {}, io: io.io, sink: undefined },
        first.deps,
      ),
    ).toBe("declined");
    expect(io.out()).toContain("Repair");

    const second = scripted([10]);
    expect(await setUpWindowsGatewayServiceForStart(input(), second.deps)).toBe("deferred");
    expect(second.calls).toEqual([["--gateway-service-status", PIN]]);
  });

  it("repairs a stale service once after an update brought a new helper", async () => {
    writeFileSync(
      join(stateDir, GATEWAY_SERVICE_SETUP_RECORD),
      JSON.stringify({ schemaVersion: 1, helperSha256: PIN }),
    );
    const helper = scripted([12, 0], { helperPath: HELPER, helperSha256: NEXT_PIN });
    expect(await setUpWindowsGatewayServiceForStart(input(), helper.deps)).toBe("installed");
    expect(helper.calls.at(-1)).toEqual(["--gateway-service-install", NEXT_PIN]);
    expect(readGatewayServiceSetupPin(stateDir)).toBe(NEXT_PIN);
  });

  it.each([
    [JSON.stringify({ schemaVersion: 2, helperSha256: PIN }), undefined],
    [JSON.stringify({ schemaVersion: 1, helperSha256: "A".repeat(64) }), undefined],
    [JSON.stringify({ schemaVersion: 1, helperSha256: PIN }), PIN],
  ])("reads only a well-formed record (%s)", (content, expected) => {
    writeFileSync(join(stateDir, GATEWAY_SERVICE_SETUP_RECORD), content);
    expect(readGatewayServiceSetupPin(stateDir)).toBe(expected);
  });

  it("does not ask when an existing record cannot be parsed", async () => {
    writeFileSync(join(stateDir, GATEWAY_SERVICE_SETUP_RECORD), "{");
    const helper = scripted([10, 0]);
    expect(await setUpWindowsGatewayServiceForStart(input(), helper.deps)).toBe(
      "record-unavailable",
    );
    expect(helper.calls).toEqual([["--gateway-service-status", PIN]]);
  });

  it("leaves an operator-managed service alone", async () => {
    const helper = scripted([10, 0]);
    const outcome = await setUpWindowsGatewayServiceForStart(
      input({ KEIKO_GATEWAY_SERVICE_SETUP: "manual" }),
      helper.deps,
    );
    expect(outcome).toBe("disabled");
    expect(helper.calls).toEqual([]);
  });

  it("asks nothing when this installation carries no approved helper", async () => {
    const helper = scripted([10, 0], null);
    expect(await setUpWindowsGatewayServiceForStart(input(), helper.deps)).toBe("no-helper");
    expect(helper.calls).toEqual([]);
  });

  it("reports a refused service change without failing", async () => {
    const helper = scripted([10, 24]);
    const io = makeIo();
    const outcome = await setUpWindowsGatewayServiceForStart(
      { stateDir, env: {}, io: io.io, sink: undefined },
      helper.deps,
    );
    expect(outcome).toBe("failed");
    expect(io.err()).toContain("Repair");
  });

  it("survives a helper that cannot be started", async () => {
    const helper = scripted([new Error(`spawn failed for ${HELPER}`)]);
    expect(await setUpWindowsGatewayServiceForStart(input(), helper.deps)).toBe("failed");
  });

  it("does not ask when the attempt cannot be remembered", async () => {
    const blocked = join(stateDir, "not-a-directory");
    writeFileSync(blocked, "");
    const helper = scripted([10, 0]);
    const outcome = await setUpWindowsGatewayServiceForStart(
      { stateDir: blocked, env: {}, io: makeIo().io, sink: undefined },
      helper.deps,
    );
    expect(outcome).toBe("record-unavailable");
    expect(helper.calls).toEqual([["--gateway-service-status", PIN]]);
  });

  it("persists body-free setup evidence through the real sink", async () => {
    const sink = createActivityLogSink(stateDir);
    await setUpWindowsGatewayServiceForStart(
      { stateDir, env: {}, io: makeIo().io, sink },
      scripted([12, 0], { helperPath: HELPER, helperSha256: PIN, lane: "npm-runtime-package" })
        .deps,
    );
    await setUpWindowsGatewayServiceForStart(
      { stateDir, env: {}, io: makeIo().io, sink },
      scripted([new Error(`spawn failed for ${HELPER}`)]).deps,
    );
    sink.close?.();
    const raw = readPersistedActivityLog(stateDir);
    expect(raw).not.toContain("customer");
    expect(readFileSync(join(stateDir, GATEWAY_SERVICE_SETUP_RECORD), "utf8")).toContain(PIN);
    const [installed, failed] = persistedActivityLogLines(raw, "cli.gateway-service.setup");
    expect(
      expectActivityLogProof("cli.gateway-service.setup.real-sink-line", installed ?? ""),
    ).toMatchObject({
      level: "info",
      outcome: "installed",
      lane: "npm-runtime-package",
      priorState: "image-mismatch",
    });
    expect(
      expectActivityLogProof("cli.gateway-service.setup.real-sink-line", failed ?? ""),
    ).toMatchObject({
      level: "warn",
      errorKind: "unavailable",
      outcome: "failed",
      reason: "helper-unavailable",
    });
  });
});
