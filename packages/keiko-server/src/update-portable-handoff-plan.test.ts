import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPortableHandoffPlan,
  encodePortableHandoffPlan,
  portableHandoffPlanSha256,
  readPortableHandoffPlan,
  syncPortableHandoffDirectory,
  writePortableHandoffPlan,
  type PortableHandoffPlanInput,
} from "./update-portable-handoff-plan.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-handoff-plan-"));
  roots.push(root);
  return root;
}

function planInput(root: string): PortableHandoffPlanInput {
  const parent = join(root, "install-parent");
  const managedRoot = join(parent, "Keiko.app");
  const stageRoot = join(parent, ".keiko-portable-updates", "stage-1");
  return {
    activationId: "a".repeat(32),
    sessionId: "session-1",
    stageId: "stage-1",
    target: "macos-arm64" as const,
    targetVersion: "1.2.3",
    newLaunchId: "2".repeat(32),
    restoreLaunchId: "3".repeat(32),
    aggregateRevision: 7,
    previousRegistrationState: "present",
    oldProcess: {
      pid: 123,
      launchId: "b".repeat(32),
      host: "127.0.0.1" as const,
      port: 1983,
      version: "1.2.2",
    },
    paths: {
      managedRoot,
      stageRoot,
      candidateRoot: join(stageRoot, "Keiko", "Keiko.app"),
      backupRoot: join(parent, `.keiko-previous-${"a".repeat(32)}`),
      candidateLauncher: join(stageRoot, "Keiko", "Keiko.app", "Contents", "MacOS", "Keiko"),
      candidateSupervisor: join(
        stageRoot,
        "Keiko",
        "Keiko.app",
        "Contents",
        "Resources",
        "runtime",
        "native",
        "keiko-runtime-supervisor",
      ),
    },
    digests: {
      currentTreeSha256: "c".repeat(64),
      candidateTreeSha256: "d".repeat(64),
      currentLauncherSha256: "3".repeat(64),
      currentSupervisorSha256: "4".repeat(64),
      candidateLauncherSha256: "e".repeat(64),
      candidateSupervisorSha256: "f".repeat(64),
      previousRegistrationSha256: "0".repeat(64),
      preparedRegistrationSha256: "1".repeat(64),
    },
    deadlines: {
      oldExitAt: 1_800_000_000_000,
      startAt: 1_800_000_030_000,
      verifyAt: 1_800_000_060_000,
      cleanupAt: 1_800_000_090_000,
    },
  };
}

function windowsPlanInput(root: string): PortableHandoffPlanInput {
  const parent = join(root, "install-parent");
  const managedRoot = join(parent, "Keiko");
  const stageRoot = join(parent, ".keiko-portable-updates", "stage-1");
  const generation = "7".repeat(64);
  return {
    ...planInput(root),
    target: "windows-x64",
    paths: {
      managedRoot,
      stageRoot,
      candidateRoot: join(stageRoot, "Keiko"),
      backupRoot: join(parent, `.keiko-previous-${"a".repeat(32)}`),
      candidateLauncher: join(stageRoot, "Keiko", "Keiko.exe"),
      candidateSupervisor: join(
        stageRoot,
        "Keiko",
        ".portable",
        "generations",
        generation,
        "runtime",
        "native",
        "keiko-runtime-supervisor.exe",
      ),
    },
    cutoverKind: "windows-generation-v1",
    currentGenerationTreeSha256: "6".repeat(64),
    candidateGenerationTreeSha256: generation,
    currentSetupManifestSha256: "8".repeat(64),
    candidateSetupManifestSha256: "9".repeat(64),
  };
}

function fixtureBytes(name: string): Buffer {
  const text = readFileSync(
    join(process.cwd(), "native", "portable-launcher", "fixtures", name),
    "ascii",
  );
  expect(text).toMatch(/^(?:[a-f0-9]{2})+\n$/u);
  return Buffer.from(text.trim(), "hex");
}

function goldenMacInput(): PortableHandoffPlanInput {
  const input = planInput("/fixture");
  return {
    ...input,
    restoreLaunchId: "5".repeat(32),
    paths: {
      managedRoot: "/Applications/Keiko.app",
      stageRoot: "/Applications/.keiko-portable-updates/stage-1",
      candidateRoot: "/Applications/.keiko-portable-updates/stage-1/Keiko/Keiko.app",
      backupRoot: `/Applications/.keiko-previous-${"a".repeat(32)}`,
      candidateLauncher:
        "/Applications/.keiko-portable-updates/stage-1/Keiko/Keiko.app/Contents/MacOS/Keiko",
      candidateSupervisor:
        "/Applications/.keiko-portable-updates/stage-1/Keiko/Keiko.app/Contents/Resources/runtime/native/keiko-runtime-supervisor",
    },
  };
}

function goldenWindowsInput(): PortableHandoffPlanInput {
  return {
    ...goldenMacInput(),
    target: "windows-x64",
    paths: {
      managedRoot: "C:\\Keiko",
      stageRoot: "C:\\.keiko-portable-updates\\stage-1",
      candidateRoot: "C:\\.keiko-portable-updates\\stage-1\\Keiko",
      backupRoot: `C:\\.keiko-previous-${"a".repeat(32)}`,
      candidateLauncher: "C:\\.keiko-portable-updates\\stage-1\\Keiko\\Keiko.exe",
      candidateSupervisor: `C:\\.keiko-portable-updates\\stage-1\\Keiko\\.portable\\generations\\${"7".repeat(64)}\\runtime\\native\\keiko-runtime-supervisor.exe`,
    },
    cutoverKind: "windows-generation-v1",
    currentGenerationTreeSha256: "6".repeat(64),
    candidateGenerationTreeSha256: "7".repeat(64),
    currentSetupManifestSha256: "8".repeat(64),
    candidateSetupManifestSha256: "9".repeat(64),
  };
}

function encodeLegacyMacPlan(plan: ReturnType<typeof createPortableHandoffPlan>): Buffer {
  if (plan.target === "windows-x64") throw new Error("legacy encoder accepts only Mac plans");
  const fields = [
    plan.activationId,
    plan.sessionId,
    plan.stageId,
    plan.target,
    plan.targetVersion,
    plan.newLaunchId,
    plan.restoreLaunchId,
    String(plan.aggregateRevision),
    plan.previousRegistrationState,
    String(plan.oldProcess.pid),
    plan.oldProcess.launchId,
    plan.oldProcess.host,
    String(plan.oldProcess.port),
    plan.oldProcess.version,
    plan.paths.managedRoot,
    plan.paths.stageRoot,
    plan.paths.candidateRoot,
    plan.paths.backupRoot,
    plan.paths.candidateLauncher,
    plan.paths.candidateSupervisor,
    plan.digests.currentTreeSha256,
    plan.digests.candidateTreeSha256,
    plan.digests.currentLauncherSha256,
    plan.digests.currentSupervisorSha256,
    plan.digests.candidateLauncherSha256,
    plan.digests.candidateSupervisorSha256,
    plan.digests.previousRegistrationSha256,
    plan.digests.preparedRegistrationSha256,
    String(plan.deadlines.oldExitAt),
    String(plan.deadlines.startAt),
    String(plan.deadlines.verifyAt),
    String(plan.deadlines.cleanupAt),
  ].map((field) => Buffer.from(field, "utf8"));
  const header = Buffer.from("4b48503102002000", "hex");
  return Buffer.concat([
    header,
    ...fields.flatMap((field) => {
      const length = Buffer.alloc(4);
      length.writeUInt32LE(field.length);
      return [length, field];
    }),
  ]);
}

function replaceKhpField(content: Buffer, fieldIndex: number, replacement: Buffer): Buffer {
  const fields: Buffer[] = [];
  let offset = 8;
  for (let index = 0; index < content.readUInt16LE(6); index += 1) {
    const length = content.readUInt32LE(offset);
    offset += 4;
    fields.push(index === fieldIndex ? replacement : content.subarray(offset, offset + length));
    offset += length;
  }
  const header = content.subarray(0, 8);
  return Buffer.concat([
    header,
    ...fields.flatMap((field) => {
      const length = Buffer.alloc(4);
      length.writeUInt32LE(field.length);
      return [length, field];
    }),
  ]);
}

function rewritePublishedPlan(path: string, fieldIndex: number, replacement: Buffer): void {
  const content = replaceKhpField(readFileSync(path), fieldIndex, replacement);
  writeFileSync(path, content);
  writeFileSync(
    join(path, "..", "plan.sha256"),
    `${createHash("sha256").update(content).digest("hex")}\n`,
  );
}

function rewritePublishedBytes(path: string, content: Buffer): void {
  writeFileSync(path, content);
  writeFileSync(
    join(path, "..", "plan.sha256"),
    `${createHash("sha256").update(content).digest("hex")}\n`,
  );
}

describe("portable handoff plan", () => {
  it("tolerates only the Windows directory-sync refusal after closing the handle", () => {
    const events: string[] = [];
    expect(() => {
      syncPortableHandoffDirectory("C:\\state", {
        platform: "win32",
        openDirectory: () => {
          events.push("open");
          return 42;
        },
        fsync: () => {
          events.push("fsync");
          throw Object.assign(new Error("directory fsync unsupported"), { code: "EPERM" });
        },
        close: () => events.push("close"),
      });
    }).not.toThrow();
    expect(events).toEqual(["open", "fsync", "close"]);

    expect(() => {
      syncPortableHandoffDirectory("/state", {
        platform: "darwin",
        openDirectory: () => 42,
        fsync: () => {
          throw Object.assign(new Error("directory fsync failed"), { code: "EPERM" });
        },
        close: () => undefined,
      });
    }).toThrow("directory fsync failed");
  });

  it("keeps both canonical fixture envelopes byte-framed on every host", () => {
    const mac = fixtureBytes("khp-v2-macos.hex");
    const windows = fixtureBytes("khp-v3-windows.hex");
    expect(mac.subarray(0, 4).toString("ascii")).toBe("KHP1");
    expect(mac.readUInt16LE(4)).toBe(2);
    expect(mac.readUInt16LE(6)).toBe(32);
    expect(readKhpFields(mac)).toHaveLength(32);
    expect(readKhpFields(mac)[3]).toBe("macos-arm64");
    expect(windows.subarray(0, 4).toString("ascii")).toBe("KHP1");
    expect(windows.readUInt16LE(4)).toBe(3);
    expect(windows.readUInt16LE(6)).toBe(37);
    expect(readKhpFields(windows).slice(32)).toEqual([
      "windows-generation-v1",
      "6".repeat(64),
      "7".repeat(64),
      "8".repeat(64),
      "9".repeat(64),
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "keeps canonical Mac KHP version 2 byte-identical on POSIX hosts",
    () => {
      const plan = createPortableHandoffPlan(goldenMacInput());
      const encoded = encodePortableHandoffPlan(plan);
      expect(encoded).toEqual(encodeLegacyMacPlan(plan));
      expect(encoded).toEqual(fixtureBytes("khp-v2-macos.hex"));
    },
  );

  it("appends only the five frozen Windows KHP version 3 fields", () => {
    const root = fixtureRoot();
    const plan = createPortableHandoffPlan(windowsPlanInput(root));
    const encoded = encodePortableHandoffPlan(plan);
    expect(encoded.readUInt16LE(4)).toBe(3);
    expect(encoded.readUInt16LE(6)).toBe(37);
    const fields = readKhpFields(encoded);
    expect(fields.slice(32)).toEqual([
      "windows-generation-v1",
      "6".repeat(64),
      "7".repeat(64),
      "8".repeat(64),
      "9".repeat(64),
    ]);
  });

  it.skipIf(process.platform !== "win32")(
    "matches the canonical Windows fixture on Windows hosts",
    () => {
      const plan = createPortableHandoffPlan(goldenWindowsInput());
      expect(encodePortableHandoffPlan(plan)).toEqual(fixtureBytes("khp-v3-windows.hex"));
    },
  );

  it("writes and reopens one canonical KHP1 plan with a stable digest", () => {
    const root = fixtureRoot();
    const stateDir = join(root, "state");
    const plan = createPortableHandoffPlan(planInput(root));

    const published = writePortableHandoffPlan({ stateDir, plan });

    expect(published.sha256).toBe(portableHandoffPlanSha256(plan));
    expect(readPortableHandoffPlan(stateDir, plan.activationId)).toStrictEqual(plan);
    expect(readFileSync(published.path).subarray(0, 4).toString("ascii")).toBe("KHP1");
    expect(() => writePortableHandoffPlan({ stateDir, plan })).toThrow(/already exists/u);
  });

  it.each([
    [3, 32],
    [2, 37],
  ])("rejects a cross-version field-count header (%i/%i)", (version, count) => {
    const root = fixtureRoot();
    const stateDir = join(root, "state");
    const plan = createPortableHandoffPlan(planInput(root));
    const published = writePortableHandoffPlan({ stateDir, plan });
    const content = readFileSync(published.path);
    content.writeUInt16LE(version, 4);
    content.writeUInt16LE(count, 6);
    rewritePublishedBytes(published.path, content);

    expect(() => readPortableHandoffPlan(stateDir, plan.activationId)).toThrow(/malformed/u);
  });

  it("rejects a KHP version 3 plan carrying a Mac target", () => {
    const root = fixtureRoot();
    const stateDir = join(root, "state");
    const plan = createPortableHandoffPlan(windowsPlanInput(root));
    const published = writePortableHandoffPlan({ stateDir, plan });
    rewritePublishedPlan(published.path, 3, Buffer.from("macos-arm64", "ascii"));

    expect(() => readPortableHandoffPlan(stateDir, plan.activationId)).toThrow(/malformed/u);
  });

  it("rejects unknown fields and trailing bytes", () => {
    const root = fixtureRoot();
    const stateDir = join(root, "state");
    const plan = createPortableHandoffPlan(planInput(root));
    const published = writePortableHandoffPlan({ stateDir, plan });
    rewritePublishedBytes(
      published.path,
      Buffer.concat([readFileSync(published.path), Buffer.from([0])]),
    );

    expect(() => readPortableHandoffPlan(stateDir, plan.activationId)).toThrow(/malformed/u);
  });

  it("rejects a plan whose candidate escapes the fixed sibling staging topology", () => {
    const root = fixtureRoot();
    const input = planInput(root);
    expect(() =>
      createPortableHandoffPlan({
        ...input,
        paths: { ...input.paths, candidateRoot: join(root, "foreign") },
      }),
    ).toThrow(/topology/u);
  });

  it("canonicalizes named fields independently of caller property insertion order", () => {
    const root = fixtureRoot();
    const input = planInput(root);
    const reordered = createPortableHandoffPlan({
      ...input,
      paths: {
        candidateSupervisor: input.paths.candidateSupervisor,
        candidateLauncher: input.paths.candidateLauncher,
        backupRoot: input.paths.backupRoot,
        candidateRoot: input.paths.candidateRoot,
        stageRoot: input.paths.stageRoot,
        managedRoot: input.paths.managedRoot,
      },
      digests: {
        preparedRegistrationSha256: input.digests.preparedRegistrationSha256,
        candidateSupervisorSha256: input.digests.candidateSupervisorSha256,
        candidateLauncherSha256: input.digests.candidateLauncherSha256,
        currentSupervisorSha256: input.digests.currentSupervisorSha256,
        currentLauncherSha256: input.digests.currentLauncherSha256,
        candidateTreeSha256: input.digests.candidateTreeSha256,
        currentTreeSha256: input.digests.currentTreeSha256,
        previousRegistrationSha256: input.digests.previousRegistrationSha256,
      },
      deadlines: {
        cleanupAt: input.deadlines.cleanupAt,
        verifyAt: input.deadlines.verifyAt,
        startAt: input.deadlines.startAt,
        oldExitAt: input.deadlines.oldExitAt,
      },
    });
    expect(portableHandoffPlanSha256(reordered)).toBe(
      portableHandoffPlanSha256(createPortableHandoffPlan(input)),
    );
    const stateDir = join(root, "reordered-state");
    writePortableHandoffPlan({ stateDir, plan: reordered });
    expect(readPortableHandoffPlan(stateDir, reordered.activationId)).toStrictEqual(
      createPortableHandoffPlan(input),
    );
  });

  it("rejects a symlink in the handoff publication path", () => {
    const root = fixtureRoot();
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(join(root, "foreign"));
    symlinkSync(join(root, "foreign"), join(stateDir, "updates"));

    expect(() =>
      writePortableHandoffPlan({ stateDir, plan: createPortableHandoffPlan(planInput(root)) }),
    ).toThrow(/unsafe/u);
  });

  it("rejects tampering when the persisted digest no longer matches", () => {
    const root = fixtureRoot();
    const stateDir = join(root, "state");
    const plan = createPortableHandoffPlan(planInput(root));
    const published = writePortableHandoffPlan({ stateDir, plan });
    writeFileSync(published.path, readFileSync(published.path, "utf8").replace("1.2.3", "9.9.9"));

    expect(() => readPortableHandoffPlan(stateDir, plan.activationId)).toThrow(/digest/u);
  });

  it("rejects high-bit digest bytes instead of ASCII-folding them", () => {
    const root = fixtureRoot();
    const stateDir = join(root, "state");
    const plan = createPortableHandoffPlan(planInput(root));
    const published = writePortableHandoffPlan({ stateDir, plan });
    const digestPath = join(dirname(published.path), "plan.sha256");
    const digest = Buffer.from(`${published.sha256}\n`, "ascii");
    digest[0] = (digest[0] ?? 0) | 0x80;
    writeFileSync(digestPath, digest);

    expect(() => readPortableHandoffPlan(stateDir, plan.activationId)).toThrow(/digest/u);
  });

  it("rejects oversized and symlink-rebound plan files before reading them", () => {
    const root = fixtureRoot();
    const firstStateDir = join(root, "oversized-state");
    const plan = createPortableHandoffPlan(planInput(root));
    const oversized = writePortableHandoffPlan({ stateDir: firstStateDir, plan });
    writeFileSync(oversized.path, Buffer.alloc(64 * 1024 + 1));
    expect(() => readPortableHandoffPlan(firstStateDir, plan.activationId)).toThrow(/unsafe/u);

    const secondStateDir = join(root, "symlink-state");
    const rebound = writePortableHandoffPlan({ stateDir: secondStateDir, plan });
    const foreign = join(root, "foreign-plan.khp");
    writeFileSync(foreign, readFileSync(rebound.path));
    rmSync(rebound.path);
    symlinkSync(foreign, rebound.path);
    expect(() => readPortableHandoffPlan(secondStateDir, plan.activationId)).toThrow(/unsafe/u);
  });

  it.each([
    [7, "0"],
    [7, "07"],
    [7, "9007199254740992"],
    [9, "0"],
    [9, "2147483648"],
    [12, "0"],
    [12, "01983"],
    [12, "65536"],
    [31, "9999999999999999"],
    [29, "1800000000000"],
  ])("rejects native-parity numeric field %i value %s", (fieldIndex, value) => {
    const root = fixtureRoot();
    const stateDir = join(root, "state");
    const plan = createPortableHandoffPlan(planInput(root));
    const published = writePortableHandoffPlan({ stateDir, plan });
    rewritePublishedPlan(published.path, fieldIndex, Buffer.from(value, "ascii"));
    expect(() => readPortableHandoffPlan(stateDir, plan.activationId)).toThrow(
      /malformed|invalid/u,
    );
  });

  it.each([
    [1, Buffer.from([0xc0, 0xaf])],
    [14, Buffer.from("relative/path", "utf8")],
    [14, Buffer.from("/Applications/../foreign", "utf8")],
  ])("rejects native-parity malformed UTF-8 or path field %i", (fieldIndex, value) => {
    const root = fixtureRoot();
    const stateDir = join(root, "state");
    const plan = createPortableHandoffPlan(planInput(root));
    const published = writePortableHandoffPlan({ stateDir, plan });
    rewritePublishedPlan(published.path, fieldIndex, value);
    expect(() => readPortableHandoffPlan(stateDir, plan.activationId)).toThrow(
      /malformed|invalid/u,
    );
  });
});

function readKhpFields(content: Buffer): readonly string[] {
  const fields: string[] = [];
  let offset = 8;
  for (let index = 0; index < content.readUInt16LE(6); index += 1) {
    const length = content.readUInt32LE(offset);
    offset += 4;
    fields.push(content.subarray(offset, offset + length).toString("utf8"));
    offset += length;
  }
  expect(offset).toBe(content.length);
  return fields;
}
