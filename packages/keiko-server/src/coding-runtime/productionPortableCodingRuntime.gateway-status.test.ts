// #4068: the gateway-service status query runs the helper only when its bytes match the pin.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultServerDiagnosticSink } from "../diagnostics-log.js";

import {
  readWindowsGatewayServiceStatus,
  runVerifiedWindowsGatewayHelper,
} from "./productionPortableCodingRuntime.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe.skipIf(process.platform === "win32")("readWindowsGatewayServiceStatus", () => {
  function helper(script: string): { readonly path: string; readonly marker: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-gateway-status-")));
    roots.push(root);
    const marker = join(root, "ran");
    const path = join(root, "keiko-runtime-supervisor");
    writeFileSync(path, script.replace("MARKER", marker), { mode: 0o700 });
    return { path, marker };
  }

  it("runs a helper whose bytes match the pin and reports its exit code", async () => {
    const script = "#!/bin/sh\nexit 12\n";
    const { path } = helper(script);
    expect(await readWindowsGatewayServiceStatus(path, digest(script))).toBe(12);
  });

  it("does not execute a swapped helper and reports not-ready", async () => {
    const pinned = "#!/bin/sh\nexit 0\n";
    const { path, marker } = helper("#!/bin/sh\ntouch MARKER\nexit 0\n");
    const recorded = vi
      .spyOn(defaultServerDiagnosticSink, "record")
      .mockImplementation(() => undefined);
    expect(await readWindowsGatewayServiceStatus(path, digest(pinned))).toBeNull();
    expect(existsSync(marker)).toBe(false);
    // The refused digest is evidence, never a silent null.
    expect(recorded).toHaveBeenCalledTimes(1);
    expect(recorded.mock.calls[0]?.[0]).toMatchObject({
      operation: "coding.runtime.windows-gateway-service.verify",
    });
  });

  // #4454: `keiko gateway-service` and the setup after `keiko start` spawned the discovered path
  // directly. They now share this runner, so the bytes that run are the verified private copy and
  // the arguments arrive exactly as given.
  it("passes the command's arguments to the verified copy", async () => {
    const script = '#!/bin/sh\nprintf "%s|" "$@" > MARKER\nexit 0\n';
    const { path, marker } = helper(script);
    const pin = digest(script.replace("MARKER", marker));
    expect(
      await runVerifiedWindowsGatewayHelper(path, pin, ["--gateway-service-uninstall"], 5_000),
    ).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("--gateway-service-uninstall|");
  });

  // Windows holds an exited helper's file for a moment: EPERM on the first removal is routine. It
  // used to be recorded as an error-level diagnostic and printed in front of every CLI answer.
  describe("private copy removal", () => {
    const script = "#!/bin/sh\nexit 12\n";
    const transient = (): Error => Object.assign(new Error("held"), { code: "EPERM" });

    it("retries a transient refusal and records nothing when it recovers", async () => {
      const { path } = helper(script);
      const recorded = vi
        .spyOn(defaultServerDiagnosticSink, "record")
        .mockImplementation(() => undefined);
      const attempts: string[] = [];
      const code = await runVerifiedWindowsGatewayHelper(
        path,
        digest(script),
        ["--gateway-service-status"],
        5_000,
        {
          remove: async (directory) => {
            attempts.push(directory);
            if (attempts.length === 1) throw transient();
            await rm(directory, { recursive: true, force: true });
          },
          sleep: () => Promise.resolve(),
        },
      );
      expect(code).toBe(12);
      expect(attempts).toHaveLength(2);
      expect(existsSync(attempts[0] ?? path)).toBe(false);
      expect(recorded).not.toHaveBeenCalled();
    });

    it("still answers with the exit code and records a copy that never goes away", async () => {
      const { path } = helper(script);
      const recorded = vi
        .spyOn(defaultServerDiagnosticSink, "record")
        .mockImplementation(() => undefined);
      let attempts = 0;
      let directory = "";
      const code = await runVerifiedWindowsGatewayHelper(
        path,
        digest(script),
        ["--gateway-service-status"],
        5_000,
        {
          remove: (target) => {
            attempts += 1;
            directory = target;
            return Promise.reject(transient());
          },
          sleep: () => Promise.resolve(),
        },
      );
      expect(code).toBe(12);
      expect(attempts).toBe(6);
      expect(recorded).toHaveBeenCalledTimes(1);
      expect(recorded.mock.calls[0]?.[0]).toMatchObject({
        operation: "coding.runtime.windows-gateway-service.cleanup",
        errorClass: "Error",
        code: "EPERM",
      });
      rmSync(directory, { recursive: true, force: true });
    });
  });

  it("never runs a swapped helper for an install or uninstall command", async () => {
    const { path, marker } = helper("#!/bin/sh\ntouch MARKER\nexit 0\n");
    vi.spyOn(defaultServerDiagnosticSink, "record").mockImplementation(() => undefined);
    expect(
      await runVerifiedWindowsGatewayHelper(
        path,
        digest("#!/bin/sh\nexit 0\n"),
        ["--gateway-service-install", "a".repeat(64)],
        5_000,
      ),
    ).toBeNull();
    expect(existsSync(marker)).toBe(false);
  });
});
