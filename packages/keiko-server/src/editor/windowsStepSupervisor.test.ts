import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
import {
  isRealDirectory,
  resolveWindowsStepSupervisor,
  windowsMavenRepository,
  windowsStepReadRoots,
  type WindowsReadRootHost,
} from "./windowsStepSupervisor.js";

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
    expect(supervisor?.mavenRepository).toBeUndefined();
    const outcomes = persistedOutcomes(stateRoot);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      op: "editor.verification.windows-step-supervisor",
      correlationId: "step-supervisor-proof",
      outcome: "available",
      readRootCount: 0,
      readRootRefusedCount: 0,
      mavenRepository: false,
    });
    copy?.release();
    expect(defined.size).toBe(0);
    await vi.waitFor(() => {
      expect(copy === undefined ? undefined : existsSync(copy.path)).toBe(false);
    });
  });

  // #4492: a refused step names the supervisor's closed code, and whether the step had started.
  it("records the supervisor's refusal code on the step's correlation", () => {
    const stateRoot = temporary("keiko-step-supervisor-log-");
    const install = temporary("keiko-step-supervisor-install-");
    const helperPath = join(install, "keiko-runtime-supervisor.exe");
    const bytes = Buffer.from("verified supervisor bytes");
    writeFileSync(helperPath, bytes);
    const supervisor = resolveWindowsStepSupervisor({
      platform: "win32",
      env: {},
      activityLog: createActivityLogSink(stateRoot),
      correlationId: "step-refused-proof",
      runtime: () => releasedRuntime(helperPath, createHash("sha256").update(bytes).digest("hex")),
      driveHost: { define: () => true, remove: () => true },
    });
    const copy = supervisor?.acquire([String.raw`C:\Users\dev\keiko-step-1`]);
    copy?.refused(12, false);
    copy?.refused(10, true);
    copy?.release();
    closeFileServerLogSinks();
    const lines = persistedActivityLogLines(
      readPersistedActivityLog(stateRoot),
      "editor.verification.windows-step-refused",
    ).map((line) =>
      expectActivityLogProof("editor.verification.windows-step-refused.emitted-line", line),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      op: "editor.verification.windows-step-refused",
      correlationId: "step-refused-proof",
      phase: "before-launch",
      refusalCode: 12,
    });
    expect(lines[1]).toMatchObject({ phase: "after-launch", refusalCode: 10 });
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
    expect(
      windowsStepReadRoots({ JAVA_HOME: jdk, MAVEN_HOME: maven, M2_HOME: file }).roots,
    ).toEqual(process.platform === "win32" ? [jdk, maven] : []);
    expect(windowsStepReadRoots({ JAVA_HOME: "relative\\jdk" }).roots).toEqual([]);
  });

  describe("a home that reaches the profile's .m2 or a credential (#4496)", () => {
    const profile = String.raw`C:\Users\dev`;
    const host = (
      entries: Readonly<Record<string, readonly string[] | null>> = {},
    ): WindowsReadRootHost => ({
      directoryOf: (value) => value,
      entryNames: (directory): readonly string[] | undefined => {
        const names = entries[directory];
        return names === null ? undefined : (names ?? []);
      },
    });

    it.each([
      ["inside .m2", String.raw`C:\Users\dev\.m2\toolchain`],
      ["inside .m2 in another case", String.raw`c:\USERS\Dev\.M2\jdk`],
      [".m2 itself", String.raw`C:\Users\dev\.m2`],
      ["the profile that holds .m2", profile],
      ["a parent of the profile", String.raw`C:\Users`],
    ])("drops a home that is %s and counts it", (_label, home) => {
      const result = windowsStepReadRoots({ JAVA_HOME: home, USERPROFILE: profile }, host());
      expect(result).toEqual({ roots: [], refusedCount: 1 });
    });

    it("drops a home inside .m2 when the profile is written with forward slashes", () => {
      const result = windowsStepReadRoots(
        { JAVA_HOME: String.raw`C:\Users\dev\.m2\jdk`, USERPROFILE: "C:/Users/dev" },
        host(),
      );
      expect(result).toEqual({ roots: [], refusedCount: 1 });
    });

    it("drops a home that holds a credential-named entry", () => {
      const home = String.raw`C:\tools\jdk`;
      const result = windowsStepReadRoots(
        { JAVA_HOME: home, USERPROFILE: profile },
        host({ [home]: ["bin", ".env"] }),
      );
      expect(result).toEqual({ roots: [], refusedCount: 1 });
    });

    it("drops a home whose entries cannot be listed", () => {
      const home = String.raw`C:\tools\locked-jdk`;
      const result = windowsStepReadRoots(
        { JAVA_HOME: home, USERPROFILE: profile },
        host({ [home]: null }),
      );
      expect(result).toEqual({ roots: [], refusedCount: 1 });
    });

    it("keeps a home outside .m2, and Maven's own conf folder with it", () => {
      const maven = String.raw`C:\tools\maven`;
      const jdk = String.raw`C:\Users\dev\Programs\jdk`;
      const result = windowsStepReadRoots(
        { JAVA_HOME: jdk, MAVEN_HOME: maven, USERPROFILE: profile },
        host({ [maven]: ["bin", "conf", "lib"] }),
      );
      expect(result).toEqual({ roots: [jdk, maven], refusedCount: 0 });
    });
  });
});

describe("windowsMavenRepository (#4492)", () => {
  const profile = String.raw`C:\Users\dev`;
  const repository = String.raw`C:\Users\dev\.m2\repository`;

  it("names the person's repository folder, never .m2 with its settings", () => {
    const asked: string[] = [];
    const found = windowsMavenRepository({ USERPROFILE: profile }, (path) => {
      asked.push(path);
      return true;
    });
    expect(found).toBe(repository);
    expect(asked).toEqual([repository]);
  });

  it("names nothing without a real folder or an absolute profile", () => {
    expect(windowsMavenRepository({ USERPROFILE: profile }, () => false)).toBeUndefined();
    expect(windowsMavenRepository({}, () => true)).toBeUndefined();
    expect(windowsMavenRepository({ USERPROFILE: "relative\\dev" }, () => true)).toBeUndefined();
    expect(windowsMavenRepository({ USERPROFILE: "/home/dev" }, () => true)).toBeUndefined();
  });

  it("takes a real folder only: no file, no link, no folder behind a linked parent", () => {
    const home = temporary("keiko-step-m2-");
    const real = join(home, "real", "repository");
    mkdirSync(real, { recursive: true });
    const file = join(home, "file");
    writeFileSync(file, "");
    const linked = join(home, "linked");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(real, linked, linkType);
    symlinkSync(join(home, "real"), join(home, "parent"), linkType);
    expect(isRealDirectory(real)).toBe(true);
    expect(isRealDirectory(file)).toBe(false);
    expect(isRealDirectory(linked)).toBe(false);
    expect(isRealDirectory(join(home, "parent", "repository"))).toBe(false);
    expect(isRealDirectory(join(home, "missing"))).toBe(false);
  });

  it("is granted by the resolved supervisor and recorded as present", () => {
    const stateRoot = temporary("keiko-step-supervisor-log-");
    const install = temporary("keiko-step-supervisor-install-");
    const helperPath = join(install, "keiko-runtime-supervisor.exe");
    const bytes = Buffer.from("verified supervisor bytes");
    writeFileSync(helperPath, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const supervisor = resolveWindowsStepSupervisor({
      platform: "win32",
      env: { USERPROFILE: profile },
      activityLog: createActivityLogSink(stateRoot),
      correlationId: "step-supervisor-maven",
      runtime: () => releasedRuntime(helperPath, sha256),
      mavenRepository: () => repository,
    });
    expect(supervisor?.mavenRepository).toBe(repository);
    const outcomes = persistedOutcomes(stateRoot);
    expect(outcomes[0]).toMatchObject({
      correlationId: "step-supervisor-maven",
      outcome: "available",
      mavenRepository: true,
    });
    expect(JSON.stringify(outcomes)).not.toContain(".m2");
  });
});
