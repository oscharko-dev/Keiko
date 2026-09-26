import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPortableHandoffTreeAttestor,
  hashPortableHandoffTree,
} from "./update-portable-handoff-builder.js";
import {
  createPortableHandoffPlan,
  type WindowsPortableHandoffPlan,
} from "./update-portable-handoff-plan.js";
import type {
  PortableHandoffReceipt,
  PortableHandoffReceiptKind,
} from "./update-portable-handoff-receipts.js";
import {
  attestWindowsGenerationInstallation,
  windowsGenerationInspectionAllowance,
} from "./update-portable-windows-inspection-allowance.js";

const roots: string[] = [];
const ACTIVATION_ID = "a".repeat(32);
const CURRENT = "b".repeat(64);
const CANDIDATE = "c".repeat(64);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function planAt(
  managedRoot: string,
  overrides: Partial<WindowsPortableHandoffPlan> = {},
): WindowsPortableHandoffPlan {
  const stageRoot = join(managedRoot, "..", ".keiko-portable-updates", "stage-1");
  const candidateRoot = join(stageRoot, "Keiko");
  const plan = createPortableHandoffPlan({
    activationId: ACTIVATION_ID,
    sessionId: "session-1",
    stageId: "stage-1",
    target: "windows-x64",
    targetVersion: "1.2.3",
    newLaunchId: "2".repeat(32),
    restoreLaunchId: "3".repeat(32),
    aggregateRevision: 2,
    previousRegistrationState: "present",
    oldProcess: {
      pid: 101,
      launchId: "1".repeat(32),
      host: "127.0.0.1",
      port: 1983,
      version: "1.2.2",
    },
    paths: {
      managedRoot,
      stageRoot,
      candidateRoot,
      backupRoot: join(managedRoot, "..", `.keiko-previous-${ACTIVATION_ID}`),
      candidateLauncher: join(candidateRoot, "Keiko.exe"),
      candidateSupervisor: join(candidateRoot, "runtime", "native", "keiko-runtime-supervisor.exe"),
    },
    digests: {
      currentTreeSha256: "4".repeat(64),
      candidateTreeSha256: "5".repeat(64),
      currentLauncherSha256: "6".repeat(64),
      currentSupervisorSha256: "7".repeat(64),
      candidateLauncherSha256: "8".repeat(64),
      candidateSupervisorSha256: "9".repeat(64),
      previousRegistrationSha256: "d".repeat(64),
      preparedRegistrationSha256: "e".repeat(64),
    },
    deadlines: { oldExitAt: 1, startAt: 2, verifyAt: 3, cleanupAt: 4 },
    cutoverKind: "windows-generation-v1",
    currentGenerationTreeSha256: CURRENT,
    candidateGenerationTreeSha256: CANDIDATE,
    currentSetupManifestSha256: "f".repeat(64),
    candidateSetupManifestSha256: "0".repeat(64),
  });
  if (plan.target !== "windows-x64") throw new Error("expected Windows plan");
  return { ...plan, ...overrides };
}

function receipts(
  ...entries: readonly (readonly [PortableHandoffReceiptKind, "intent" | "completed"])[]
): readonly PortableHandoffReceipt[] {
  return entries.map(([kind, outcome], index) => ({
    schemaVersion: 1,
    activationId: ACTIVATION_ID,
    planSha256: "1".repeat(64),
    sequence: index + 1,
    kind,
    outcome,
    at: index + 1,
    ...(index === 0 ? {} : { previousSha256: "2".repeat(64) }),
  }));
}

const THROUGH_PROMOTE_INTENT = [
  ["prepared", "completed"],
  ["old-exit", "intent"],
  ["old-exit", "completed"],
  ["promote", "intent"],
] as const;
const THROUGH_START = [
  ...THROUGH_PROMOTE_INTENT,
  ["promote", "completed"],
  ["register", "intent"],
  ["register", "completed"],
  ["start", "intent"],
  ["start", "completed"],
] as const;

describe("Windows generation inspection allowance", () => {
  it.each([
    ["before promote", receipts(), [CURRENT]],
    ["promote intent", receipts(...THROUGH_PROMOTE_INTENT), [CURRENT, CANDIDATE, "incoming"]],
    [
      "restore intent",
      receipts(...THROUGH_START, ["restore", "intent"]),
      [CURRENT, CANDIDATE, "incoming"],
    ],
    [
      "restore complete",
      receipts(...THROUGH_START, ["restore", "intent"], ["restore", "completed"]),
      [CURRENT],
    ],
    [
      "cleanup intent",
      receipts(
        ...THROUGH_START,
        ["verify", "intent"],
        ["verify", "completed"],
        ["cleanup", "intent"],
      ),
      [CURRENT, CANDIDATE, "incoming"],
    ],
    [
      "cleanup complete",
      receipts(
        ...THROUGH_START,
        ["verify", "intent"],
        ["verify", "completed"],
        ["cleanup", "intent"],
        ["cleanup", "completed"],
      ),
      [CANDIDATE],
    ],
  ] as const)("grants only the %s generation prefix", (_label, phaseReceipts, expected) => {
    const plan = planAt(resolve("fixture", "Keiko"));
    const allowance = windowsGenerationInspectionAllowance(plan, phaseReceipts);
    expect(allowance).toEqual({
      kind: "windows-generation-v1",
      managedRoot: plan.paths.managedRoot,
      activationId: ACTIVATION_ID,
      allowedResourceRoots: expected.map((value) =>
        value === "incoming"
          ? `.portable/generations/.incoming-${ACTIVATION_ID}`
          : `.portable/generations/${value}`,
      ),
    });
  });
});

async function activeFixture(): Promise<{
  readonly generationFile: string;
  readonly launcherPath: string;
  readonly plan: WindowsPortableHandoffPlan;
  readonly registrationPath: string;
  readonly setupPath: string;
  readonly stateDir: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "keiko-windows-active-attestation-"));
  roots.push(root);
  const managedRoot = join(root, "Keiko");
  const stateDir = join(root, "state");
  const generations = join(managedRoot, ".portable", "generations");
  const stagedGeneration = join(generations, "staged");
  mkdirSync(stagedGeneration, { recursive: true });
  const generationFile = join(stagedGeneration, "runtime.txt");
  writeFileSync(generationFile, "generation bytes");
  const treeSha256 = await hashPortableHandoffTree(stagedGeneration, {
    deadline: Date.now() + 30_000,
  });
  const generationRoot = join(generations, treeSha256);
  renameSync(stagedGeneration, generationRoot);
  const finalGenerationFile = join(generationRoot, "runtime.txt");
  mkdirSync(stateDir, { recursive: true });
  const launcher = "signed launcher fixture";
  const launcherPath = join(managedRoot, "Keiko.exe");
  writeFileSync(launcherPath, launcher);
  const windowsGeneration = {
    schemaVersion: 1 as const,
    resourceRoot: `.portable/generations/${treeSha256}`,
    treeHashSchema: "KHT1" as const,
    treeSha256,
    launcherPath: "Keiko.exe" as const,
    launcherSha256: sha256(launcher),
  };
  const setup = JSON.stringify({
    schemaVersion: 2,
    platformTarget: "windows-x64",
    packageVersion: "1.2.2",
    stable: true,
    windowsGeneration,
  });
  const setupPath = join(managedRoot, ".portable", "setup-manifest.json");
  writeFileSync(setupPath, setup);
  const registration = JSON.stringify({
    schemaVersion: 2,
    status: "managed",
    updateEligible: true,
    stable: true,
    platformTarget: "windows-x64",
    packageVersion: "1.2.2",
    installRootIdentitySha256: sha256(realpathSync(managedRoot)),
    setupManifestSha256: sha256(setup),
    launcherIdentitySha256: sha256(launcher),
    windowsGeneration,
  });
  const registrationPath = join(stateDir, "portable-install-state.json");
  writeFileSync(registrationPath, registration);
  const plan = planAt(managedRoot, {
    currentGenerationTreeSha256: treeSha256,
    currentSetupManifestSha256: sha256(setup),
    digests: {
      ...planAt(managedRoot).digests,
      currentLauncherSha256: sha256(launcher),
      previousRegistrationSha256: sha256(registration),
    },
  });
  expect(await createPortableHandoffTreeAttestor({ managedRoot: generationRoot })(treeSha256)).toBe(
    true,
  );
  return {
    generationFile: finalGenerationFile,
    launcherPath,
    plan,
    registrationPath,
    setupPath,
    stateDir,
  };
}

describe("Windows generation active installation attestation", () => {
  it("binds generation KHT1, root setup, launcher and registration", async () => {
    const fixture = await activeFixture();
    await expect(
      attestWindowsGenerationInstallation({
        plan: fixture.plan,
        selection: "current",
        stateDir: fixture.stateDir,
      }),
    ).resolves.toBe(true);
  });

  it("rejects a root launcher digest that is not the selected plan binding", async () => {
    const fixture = await activeFixture();
    const plan = {
      ...fixture.plan,
      digests: { ...fixture.plan.digests, currentLauncherSha256: "f".repeat(64) },
    };

    await expect(
      attestWindowsGenerationInstallation({
        plan,
        selection: "current",
        stateDir: fixture.stateDir,
      }),
    ).resolves.toBe(false);
  });

  it.each(["generation", "setup", "launcher", "registration"] as const)(
    "rejects drifted %s authority",
    async (authority) => {
      const fixture = await activeFixture();
      const path =
        authority === "generation"
          ? fixture.generationFile
          : authority === "setup"
            ? fixture.setupPath
            : authority === "launcher"
              ? fixture.launcherPath
              : fixture.registrationPath;
      writeFileSync(path, "drifted");
      await expect(
        attestWindowsGenerationInstallation({
          plan: fixture.plan,
          selection: "current",
          stateDir: fixture.stateDir,
        }),
      ).resolves.toBe(false);
    },
  );
});
