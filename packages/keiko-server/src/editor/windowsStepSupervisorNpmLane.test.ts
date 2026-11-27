import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";

const discovered = vi.hoisted((): { runtime: unknown; hosts: unknown[] } => ({
  runtime: undefined,
  hosts: [],
}));

vi.mock("../coding-runtime/runtimeLaneDiscovery.js", () => ({
  discoverActivatedRuntime: (host: unknown): unknown => {
    discovered.hosts.push(host);
    return discovered.runtime;
  },
}));

import { resetRunRuntimesForTest, resolveWindowsStepSupervisor } from "./windowsStepSupervisor.js";

// #4491: an npm installation (`npm install @oscharko-dev/keiko` plus the optional Windows runtime
// package) starts its Coding runs from the npm lane, but its verification steps resolved only the
// packaged release and the dev checkout, so a Maven step was never governed and never ran.

const roots: string[] = [];

afterEach(() => {
  discovered.runtime = undefined;
  discovered.hosts = [];
  resetRunRuntimesForTest();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function npmLaneRuntime(bytes: Buffer, helperPath: string): unknown {
  return {
    lane: "npm-runtime-package",
    target: "windows-x64",
    nativeHelperPath: helperPath,
    nativeHelperSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

describe("the Windows step supervisor on the npm lane (#4491)", () => {
  it("is available for the runtime the Coding activation found, resolved through the shared order", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-npm-step-supervisor-")));
    roots.push(root);
    const helperPath = join(root, "keiko-runtime-supervisor.exe");
    const bytes = Buffer.from("npm lane supervisor bytes");
    writeFileSync(helperPath, bytes);
    discovered.runtime = npmLaneRuntime(bytes, helperPath);
    const events: ServerLogEvent[] = [];
    const env = { USERPROFILE: String.raw`C:\Users\dev` };

    const supervisor = resolveWindowsStepSupervisor({
      platform: "win32",
      env,
      activityLog: { write: (event): void => void events.push(event) },
      correlationId: "npm-lane-step-supervisor",
    });

    expect(supervisor).toBeDefined();
    expect(discovered.hosts).toEqual([{ env, correlationId: "npm-lane-step-supervisor" }]);
    const line = events.find((event) => event.op === "editor.verification.windows-step-supervisor");
    expect(line?.extra?.outcome).toBe("available");
    expect(line?.correlationId).toBe("npm-lane-step-supervisor");
  });

  it("stays absent, recorded as no-runtime, when no lane holds an activated runtime", () => {
    const events: ServerLogEvent[] = [];
    expect(
      resolveWindowsStepSupervisor({
        platform: "win32",
        env: {},
        activityLog: { write: (event): void => void events.push(event) },
      }),
    ).toBeUndefined();
    expect(
      events.find((event) => event.op === "editor.verification.windows-step-supervisor")?.extra,
    ).toMatchObject({ outcome: "no-runtime" });
  });
  // The probe and the run both resolve the supervisor; the payload verification behind it happens
  // once per run, and a failure it records carries that run's correlation id.
  it("discovers once per verification run and hands the run's correlation id to the discovery", () => {
    const log = { write: (): void => undefined };
    const env = {};
    for (let resolution = 0; resolution < 2; resolution += 1) {
      resolveWindowsStepSupervisor({
        platform: "win32",
        env,
        activityLog: log,
        correlationId: "run-a",
      });
    }
    resolveWindowsStepSupervisor({
      platform: "win32",
      env,
      activityLog: log,
      correlationId: "run-b",
    });
    resolveWindowsStepSupervisor({ platform: "win32", env, activityLog: log });
    resolveWindowsStepSupervisor({ platform: "win32", env, activityLog: log });
    expect(discovered.hosts).toEqual([
      { env, correlationId: "run-a" },
      { env, correlationId: "run-b" },
      { env },
      { env },
    ]);
  });
});
