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
  realDirectory,
  resolveWindowsStepSupervisor,
  windowsMavenRepository,
  windowsReadRootAdmission,
  windowsStepReadRoots,
  type RealDirectoryFs,
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
      readRootRefusedDriveRootCount: 0,
      readRootRefusedM2Count: 0,
      readRootRefusedCredentialCount: 0,
      readRootRefusedUnlistableCount: 0,
      mavenRepository: false,
      stepNodeMismatch: "none",
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
    // A known profile that holds neither home; the homes are named by their real paths.
    const profile = temporary("keiko-step-profile-");
    const real = (path: string): string => realpathSync.native(path);
    // Absolute Windows paths only: on this host a POSIX path is not one, so nothing is named.
    expect(
      windowsStepReadRoots({
        JAVA_HOME: jdk,
        MAVEN_HOME: maven,
        M2_HOME: file,
        USERPROFILE: profile,
      }).roots,
    ).toEqual(process.platform === "win32" ? [real(jdk), real(maven)] : []);
    expect(windowsStepReadRoots({ JAVA_HOME: "relative\\jdk" }).roots).toEqual([]);
  });

  describe("a home that reaches the profile's .m2 or a credential (#4496)", () => {
    const profile = String.raw`C:\Users\dev`;
    const none = { "drive-root": 0, m2: 0, credential: 0, unlistable: 0 };
    // `real` maps a short name or a junction to the folder it reaches, as the real host's
    // realpath does; every other path is its own real path.
    const host = (
      entries: Readonly<Record<string, readonly string[] | null>> = {},
      real: Readonly<Record<string, string>> = {},
    ): WindowsReadRootHost => ({
      realDirectory: (value): string | undefined =>
        value === undefined ? undefined : (real[value] ?? value),
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
      expect(result).toEqual({ roots: [], profile, refused: { ...none, m2: 1 } });
    });

    it.each([
      ["a short name", String.raw`C:\Users\DEV~1\.m2\jdk`],
      ["a junction", String.raw`C:\link\jdk`],
    ])("drops a home inside .m2 that is reached through %s", (_label, home) => {
      const result = windowsStepReadRoots(
        { JAVA_HOME: home, USERPROFILE: profile },
        host({}, { [home]: String.raw`C:\Users\dev\.m2\jdk` }),
      );
      expect(result).toEqual({ roots: [], profile, refused: { ...none, m2: 1 } });
    });

    it("drops a home inside a relocated .m2 that the profile reaches through a junction", () => {
      const home = String.raw`D:\m2\maven`;
      const result = windowsStepReadRoots(
        { MAVEN_HOME: home, USERPROFILE: profile },
        host({}, { [String.raw`C:\Users\dev\.m2`]: String.raw`D:\m2` }),
      );
      expect(result).toEqual({ roots: [], profile, refused: { ...none, m2: 1 } });
      const admit = windowsReadRootAdmission(
        profile,
        host({}, { [String.raw`C:\Users\dev\.m2`]: String.raw`D:\m2` }),
      );
      expect(admit(String.raw`D:\m2\jdk`)).toEqual({ refusal: "m2" });
      expect(admit(String.raw`D:\other\jdk`)).toEqual({ root: String.raw`D:\other\jdk` });
    });

    it("sees a .m2 relocated after the supervisor was resolved", () => {
      const real: Record<string, string> = {};
      const admit = windowsReadRootAdmission(profile, host({}, real));
      expect(admit(String.raw`D:\m2\jdk`)).toEqual({ root: String.raw`D:\m2\jdk` });
      real[String.raw`C:\Users\dev\.m2`] = String.raw`D:\m2`;
      expect(admit(String.raw`D:\m2\jdk`)).toEqual({ refusal: "m2" });
    });

    it("judges and counts a folder once when several homes name it", () => {
      const home = String.raw`C:\Users\dev\.m2\maven`;
      const result = windowsStepReadRoots(
        { MAVEN_HOME: home, M2_HOME: home, USERPROFILE: profile },
        host(),
      );
      expect(result).toEqual({ roots: [], profile, refused: { ...none, m2: 1 } });
    });

    it("compares against the profile's real path when it is named by a short name", () => {
      const short = String.raw`C:\Users\DEV~1`;
      const result = windowsStepReadRoots(
        { JAVA_HOME: String.raw`C:\Users\dev\.m2\jdk`, USERPROFILE: short },
        host({}, { [short]: profile }),
      );
      expect(result).toEqual({ roots: [], profile, refused: { ...none, m2: 1 } });
    });

    it("drops a home inside .m2 when the profile is written with forward slashes", () => {
      const result = windowsStepReadRoots(
        { JAVA_HOME: String.raw`C:\Users\dev\.m2\jdk`, USERPROFILE: "C:/Users/dev" },
        host({}, { "C:/Users/dev": profile }),
      );
      expect(result).toEqual({ roots: [], profile, refused: { ...none, m2: 1 } });
    });

    it.each(["D:\\", "e:\\"])("drops the drive root %s and counts it", (home) => {
      const result = windowsStepReadRoots({ JAVA_HOME: home, USERPROFILE: profile }, host());
      expect(result).toEqual({ roots: [], profile, refused: { ...none, "drive-root": 1 } });
      expect(windowsReadRootAdmission(profile, host())(home)).toEqual({ refusal: "drive-root" });
    });

    it.each([
      ["inside .ssh", String.raw`C:\Users\dev\.ssh\tools`],
      ["inside .aws in another case", String.raw`c:\users\DEV\.AWS\cli`],
      ["the folder that holds .cargo's credentials", String.raw`C:\Users\dev\.cargo`],
      ["the folder that holds the gh store", String.raw`C:\Users\dev\.config`],
      [
        "the folder that holds the Windows credential store",
        String.raw`C:\Users\dev\AppData\Roaming`,
      ],
      ["inside the DPAPI keys", String.raw`C:\Users\dev\AppData\Roaming\Microsoft\Protect\x`],
      ["inside OpenCode's own state", String.raw`C:\Users\dev\.local\share\opencode\bin`],
    ])("drops a home that is %s, as the macOS profile denies it", (_label, home) => {
      const result = windowsStepReadRoots({ JAVA_HOME: home, USERPROFILE: profile }, host());
      expect(result).toEqual({ roots: [], profile, refused: { ...none, credential: 1 } });
    });

    it("drops a home inside a credential store the profile reaches through a junction", () => {
      const relocated = host({}, { [String.raw`C:\Users\dev\.aws`]: String.raw`D:\aws` });
      const result = windowsStepReadRoots(
        { JAVA_HOME: String.raw`D:\aws\cli`, USERPROFILE: profile },
        relocated,
      );
      expect(result).toEqual({ roots: [], profile, refused: { ...none, credential: 1 } });
      expect(windowsReadRootAdmission(profile, relocated)(String.raw`D:\tools\cli`)).toEqual({
        root: String.raw`D:\tools\cli`,
      });
    });

    it("keeps a bin folder beside a credential store, as macOS keeps ~/.cargo/bin", () => {
      const bin = String.raw`C:\Users\dev\.cargo\bin`;
      expect(windowsReadRootAdmission(profile, host())(bin)).toEqual({ root: bin });
    });

    it("drops a home that holds a credential-named entry", () => {
      const home = String.raw`C:\tools\jdk`;
      const result = windowsStepReadRoots(
        { JAVA_HOME: home, USERPROFILE: profile },
        host({ [home]: ["bin", ".env"] }),
      );
      expect(result).toEqual({ roots: [], profile, refused: { ...none, credential: 1 } });
    });

    it("drops a home whose entries cannot be listed", () => {
      const home = String.raw`C:\tools\locked-jdk`;
      const result = windowsStepReadRoots(
        { JAVA_HOME: home, USERPROFILE: profile },
        host({ [home]: null }),
      );
      expect(result).toEqual({ roots: [], profile, refused: { ...none, unlistable: 1 } });
    });

    it("admits nothing when the profile folder is unknown", () => {
      const result = windowsStepReadRoots({ JAVA_HOME: String.raw`C:\tools\jdk` }, host());
      expect(result).toEqual({ roots: [], profile: undefined, refused: none });
      expect(windowsReadRootAdmission(undefined, host())(String.raw`C:\tools\jdk`)).toEqual({});
    });

    it("keeps a home outside .m2 by its real path, and Maven's own conf folder with it", () => {
      const maven = String.raw`C:\tools\maven`;
      const jdk = String.raw`C:\Users\dev\Programs\jdk`;
      const result = windowsStepReadRoots(
        { JAVA_HOME: String.raw`C:\PROGRA~1\jdk`, MAVEN_HOME: maven, USERPROFILE: profile },
        host({ [maven]: ["bin", "conf", "lib"] }, { [String.raw`C:\PROGRA~1\jdk`]: jdk }),
      );
      expect(result).toEqual({ roots: [jdk, maven], profile, refused: none });
    });

    it("admits a step's own toolchain folder by the same rules", () => {
      const admit = windowsReadRootAdmission(
        profile,
        host({ [String.raw`C:\tools\secret`]: ["bin", ".npmrc"] }),
      );
      expect(admit(String.raw`C:\tools\node`)).toEqual({ root: String.raw`C:\tools\node` });
      expect(admit(String.raw`C:\tools\secret`)).toEqual({ refusal: "credential" });
      expect(admit(String.raw`C:\Users\dev\.m2\wrapper`)).toEqual({ refusal: "m2" });
    });
  });
});

describe("realDirectory (#4496)", () => {
  const folder = String.raw`C:\tools\jdk`;

  it("resolves a drive folder to its real drive path", () => {
    const fs = { isDirectory: (): boolean => true, realpath: (): string => "C:/Tools/JDK" };
    expect(realDirectory(folder, fs)).toBe(String.raw`C:\Tools\JDK`);
  });

  it("is no folder when the path is no drive folder or resolves off the drive", () => {
    const resolves = (real: string): RealDirectoryFs => ({
      isDirectory: (): boolean => true,
      realpath: (): string => real,
    });
    expect(realDirectory(undefined, resolves(folder))).toBeUndefined();
    expect(realDirectory("", resolves(folder))).toBeUndefined();
    expect(realDirectory(String.raw`\\server\share`, resolves(folder))).toBeUndefined();
    expect(realDirectory(folder, resolves(String.raw`\\server\share\jdk`))).toBeUndefined();
    const missing: RealDirectoryFs = {
      isDirectory: (): undefined => undefined,
      realpath: (): string => folder,
    };
    expect(realDirectory(folder, missing)).toBeUndefined();
  });

  it("is no folder, never a throw, when the file system refuses the lookup", () => {
    const refusing =
      (error: string): (() => never) =>
      (): never => {
        throw Object.assign(new Error(error), { code: error });
      };
    const statRefused: RealDirectoryFs = {
      isDirectory: refusing("EACCES"),
      realpath: (): string => folder,
    };
    const realpathRefused = { isDirectory: (): boolean => true, realpath: refusing("EPERM") };
    expect(realDirectory(folder, statRefused)).toBeUndefined();
    expect(realDirectory(folder, realpathRefused)).toBeUndefined();
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
