import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeFileServerLogSinks, createActivityLogSink } from "../observability/index.js";
import type { ResolvedPortableOpenCodeRuntime } from "../coding-runtime/productionOpenCodeBackend.js";
import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../../tests/support/activity-log-proof.js";
import { CommandDeniedError } from "@oscharko-dev/keiko-security";
import { ISOLATION_UNAVAILABLE_DENIAL_PREFIX } from "@oscharko-dev/keiko-verification";
import { resolveWindowsStepSupervisor, windowsStepReadRoots } from "./windowsStepSupervisor.js";

const roots: string[] = [];

afterEach(() => {
  closeFileServerLogSinks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporary(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

/** A released Windows runtime whose supervisor bytes match (or miss) its pin. */
function releasedRuntime(helperPath: string, sha256: string): ResolvedPortableOpenCodeRuntime {
  return {
    target: "windows-x64",
    platformAssurance: "release-qualified",
    nativeHelperPath: helperPath,
    nativeHelperSha256: sha256,
  } as unknown as ResolvedPortableOpenCodeRuntime;
}

function persistedOutcomes(stateRoot: string): readonly Record<string, unknown>[] {
  closeFileServerLogSinks();
  return persistedActivityLogLines(
    readPersistedActivityLog(stateRoot),
    "editor.verification.windows-step-supervisor",
  ).map((line) =>
    expectActivityLogProof("editor.verification.windows-step-supervisor.emitted-line", line),
  );
}

describe("resolveWindowsStepSupervisor (#4496)", () => {
  it("is absent off Windows and records nothing there", () => {
    const stateRoot = temporary("keiko-step-supervisor-log-");
    expect(
      resolveWindowsStepSupervisor({
        platform: "darwin",
        activityLog: createActivityLogSink(stateRoot),
        runtime: () => {
          throw new Error("must not discover a runtime off Windows");
        },
      }),
    ).toBeUndefined();
    expect(persistedOutcomes(stateRoot)).toEqual([]);
  });

  it("hands out verified private copies of the pinned supervisor and records it available", async () => {
    const defined = new Map<string, string>();
    const drives = {
      define: (drive: string, root: string): boolean => {
        defined.set(drive, root);
        return true;
      },
      remove: (drive: string): boolean => defined.delete(drive),
    };
    const stateRoot = temporary("keiko-step-supervisor-log-");
    const install = temporary("keiko-step-supervisor-install-");
    const helperPath = join(install, "keiko-runtime-supervisor.exe");
    const bytes = Buffer.from("verified supervisor bytes");
    writeFileSync(helperPath, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const supervisor = resolveWindowsStepSupervisor({
      platform: "win32",
      env: {},
      activityLog: createActivityLogSink(stateRoot),
      correlationId: "step-supervisor-proof",
      runtime: () => releasedRuntime(helperPath, sha256),
      driveHost: drives,
    });
    expect(supervisor).toBeDefined();
    const work = String.raw`C:\Users\dev\keiko-step-1`;
    const copy = supervisor?.acquire([work, String.raw`C:\Program Files\Java\jdk-21`]);
    expect(copy?.path).not.toBe(helperPath);
    expect(copy === undefined ? undefined : existsSync(copy.path)).toBe(true);
    expect(copy?.drives).toEqual([
      { root: work, drive: "Z:" },
      { root: String.raw`C:\Program Files\Java\jdk-21`, drive: "Y:" },
    ]);
    expect(supervisor?.readRoots).toEqual([]);
    const outcomes = persistedOutcomes(stateRoot);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      op: "editor.verification.windows-step-supervisor",
      correlationId: "step-supervisor-proof",
      outcome: "available",
      readRootCount: 0,
    });
    copy?.release();
    expect(defined.size).toBe(0);
    await vi.waitFor(() => {
      expect(copy === undefined ? undefined : existsSync(copy.path)).toBe(false);
    });
  });

  it("refuses a step that gets no drive letters as isolation unavailable", () => {
    const install = temporary("keiko-step-supervisor-install-");
    const helperPath = join(install, "keiko-runtime-supervisor.exe");
    const bytes = Buffer.from("verified supervisor bytes");
    writeFileSync(helperPath, bytes);
    const supervisor = resolveWindowsStepSupervisor({
      platform: "win32",
      env: {},
      activityLog: createActivityLogSink(temporary("keiko-step-supervisor-log-")),
      runtime: () => releasedRuntime(helperPath, createHash("sha256").update(bytes).digest("hex")),
      driveHost: { define: () => false, remove: () => true },
    });
    expect(() => supervisor?.acquire([String.raw`C:\Users\dev\keiko-step-1`])).toThrow(
      ISOLATION_UNAVAILABLE_DENIAL_PREFIX,
    );
  });

  it("is absent for a supervisor whose bytes miss the pin, and records why", () => {
    const stateRoot = temporary("keiko-step-supervisor-log-");
    const install = temporary("keiko-step-supervisor-install-");
    const helperPath = join(install, "keiko-runtime-supervisor.exe");
    writeFileSync(helperPath, "replaced bytes");
    expect(
      resolveWindowsStepSupervisor({
        platform: "win32",
        env: {},
        activityLog: createActivityLogSink(stateRoot),
        runtime: () => releasedRuntime(helperPath, "0".repeat(64)),
      }),
    ).toBeUndefined();
    expect(persistedOutcomes(stateRoot)[0]).toMatchObject({ outcome: "pin-mismatch" });
  });

  it("refuses a step as isolation unavailable when the bytes change after resolving", () => {
    const install = temporary("keiko-step-supervisor-install-");
    const helperPath = join(install, "keiko-runtime-supervisor.exe");
    const bytes = Buffer.from("verified supervisor bytes");
    writeFileSync(helperPath, bytes);
    const supervisor = resolveWindowsStepSupervisor({
      platform: "win32",
      env: {},
      activityLog: createActivityLogSink(temporary("keiko-step-supervisor-log-")),
      runtime: () => releasedRuntime(helperPath, createHash("sha256").update(bytes).digest("hex")),
    });
    writeFileSync(helperPath, "replaced bytes");
    let refusal: unknown;
    try {
      supervisor?.acquire([install]);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(CommandDeniedError);
    expect((refusal as Error).message.startsWith(ISOLATION_UNAVAILABLE_DENIAL_PREFIX)).toBe(true);
  });

  it("is absent without a runtime, and records why", () => {
    const stateRoot = temporary("keiko-step-supervisor-log-");
    expect(
      resolveWindowsStepSupervisor({
        platform: "win32",
        env: {},
        activityLog: createActivityLogSink(stateRoot),
        runtime: () => undefined,
      }),
    ).toBeUndefined();
    expect(persistedOutcomes(stateRoot)[0]).toMatchObject({ outcome: "no-runtime" });
  });
  it("is absent for a runtime that carries no supervisor pin, and records why", () => {
    const stateRoot = temporary("keiko-step-supervisor-log-");
    const helperPath = join(temporary("keiko-step-supervisor-install-"), "supervisor.exe");
    writeFileSync(helperPath, "unpinned supervisor bytes");
    const unpinned = { nativeHelperPath: helperPath } as unknown as ResolvedPortableOpenCodeRuntime;
    expect(
      resolveWindowsStepSupervisor({
        platform: "win32",
        env: {},
        activityLog: createActivityLogSink(stateRoot),
        runtime: () => unpinned,
      }),
    ).toBeUndefined();
    expect(persistedOutcomes(stateRoot)[0]).toMatchObject({ outcome: "no-pin" });
  });
});

describe("windowsStepReadRoots", () => {
  it("names the existing Java and Maven homes once, and nothing that is not a folder", () => {
    const jdk = temporary("keiko-step-jdk-");
    const maven = join(temporary("keiko-step-maven-"), "maven");
    mkdirSync(maven);
    const file = join(jdk, "release");
    writeFileSync(file, "");
    // Absolute Windows paths only: on this host a POSIX path is not one, so nothing is named.
    expect(windowsStepReadRoots({ JAVA_HOME: jdk, MAVEN_HOME: maven, M2_HOME: file })).toEqual(
      process.platform === "win32" ? [jdk, maven] : [],
    );
    expect(windowsStepReadRoots({ JAVA_HOME: "relative\\jdk" })).toEqual([]);
  });
});
