// #4068: the gateway-service status query runs the helper only when its bytes match the pin.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultServerDiagnosticSink } from "../diagnostics-log.js";

import { readWindowsGatewayServiceStatus } from "./productionPortableCodingRuntime.js";

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
});
