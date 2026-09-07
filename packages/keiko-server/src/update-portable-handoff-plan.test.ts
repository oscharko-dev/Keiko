import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPortableHandoffPlan,
  portableHandoffPlanSha256,
  readPortableHandoffPlan,
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

describe("portable handoff plan", () => {
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
