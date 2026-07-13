import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdatePortableStagingSummary } from "@oscharko-dev/keiko-contracts";
import { createUpdateLocalStateManager } from "./update-local-state.js";
import { createPortableUpdateActivator } from "./update-portable-activation.js";
import {
  activationIdFor,
  capturePortableRegistration,
  readPortableActivationRecovery,
} from "./update-portable-activation-files.js";

const TARGET_VERSION = "0.2.12";
const OLD_VERSION = "0.2.11";
const TARGET = "windows-x64";
const ARTIFACT_SHA256 = "a".repeat(64);
const SOURCE_COMMIT_SHA = "c".repeat(40);
const SIDECAR_ROOT = "runtime/sidecars/opencode-compatible";
const tempRoots: string[] = [];

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sidecarFixture(): {
  readonly runtime: Record<string, unknown>;
  readonly files: Readonly<Record<string, string>>;
  readonly payloadSha256: string;
} {
  const files = {
    "LICENSE.txt": "sidecar license",
    "evidence/sbom.cdx.json": '{"bomFormat":"CycloneDX"}',
    "opencode.cmd": "@echo off\r\n",
  } as const;
  const payloadHash = createHash("sha256");
  for (const [path, bytes] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    payloadHash.update(`${path}\0${sha256(bytes)}\0`);
  }
  const payloadSha256 = payloadHash.digest("hex");
  const executableSha256 = sha256(files["opencode.cmd"]);
  const runtime = {
    approvalSchemaVersion: 2,
    name: "opencode-compatible",
    kind: "coding-runtime",
    upstream: {
      owner: "anomalyco",
      repository: "opencode",
      name: "opencode",
      version: "1.17.17",
      tag: "v1.17.17",
      commit: "474abdd7ee60f4b67476cfcef7e5311beff4a824",
    },
    adapterCompatibility: {
      adapterName: "keiko-coding-sidecar",
      adapterVersion: "1",
      transport: "http-sse",
    },
    protocolSchema: {
      path: "packages/sdk/openapi.json",
      sha256: "7db5cc3bb494b4757655110f2f285b1e70fa586fb5ae2327ffb31d4f0254c7de",
      hashAlgorithm: "sha256",
      hashEncoding: "lowercase-hex",
      digestInput: "upstream-raw-bytes",
      transport: "http-sse",
    },
    releaseApproval: { redistribution: { status: "approved" } },
    archive: { platformTarget: TARGET, sha256: "d".repeat(64) },
    executableTreeAlgorithm: "keiko-directory-tree-sha256-v1",
    executableTreeSha256: "f".repeat(64),
    platformTarget: TARGET,
    payloadRootPath: SIDECAR_ROOT,
    executablePath: `${SIDECAR_ROOT}/opencode.cmd`,
    payloadSha256,
    sizeBytes: Object.values(files).reduce((sum, bytes) => sum + Buffer.byteLength(bytes), 0),
    licenseEvidence: { path: `${SIDECAR_ROOT}/LICENSE.txt`, sha256: sha256(files["LICENSE.txt"]) },
    sbomEvidence: {
      path: `${SIDECAR_ROOT}/evidence/sbom.cdx.json`,
      sha256: sha256(files["evidence/sbom.cdx.json"]),
    },
    signing: {
      verificationPolicy: "production",
      verificationStatus: "verified-production",
      verificationReasonCodes: [],
      signatureKind: "authenticode",
      signatureVerified: true,
      notarizationRequired: false,
      notarizationVerified: false,
      verificationChecks: { publisherChainVerified: true, timestampVerified: true },
      shippedExecutableSha256: executableSha256,
      shippedExecutableTreeAlgorithm: "keiko-directory-tree-sha256-v1",
      shippedExecutableTreeSha256: sha256(`opencode.cmd\0${executableSha256}\0`),
    },
  };
  return { runtime, files, payloadSha256 };
}

function portableManifest(withSidecar = false): string {
  const sidecars = withSidecar ? [sidecarFixture().runtime] : [];
  return JSON.stringify({
    release: { commitSha: SOURCE_COMMIT_SHA },
    artifact: { platformTarget: TARGET, sha256: ARTIFACT_SHA256 },
    releaseImpact: {
      reviewedBinding: {
        ...(sidecars.length === 0 ? {} : { sidecarRuntimes: sidecars }),
      },
    },
    ...(sidecars.length === 0 ? {} : { sidecarRuntimes: sidecars }),
  });
}

function setupManifest(version: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    platformTarget: TARGET,
    packageName: "@oscharko-dev/keiko",
    packageVersion: version,
    stable: true,
    primaryLauncher: "Keiko.exe",
    bootstrapUpdateEligible: false,
    runtime: { nodePlatform: "win32", nodeArchitecture: "x64" },
  });
}

function writeInstall(root: string, version: string, withSidecar = false): void {
  mkdirSync(join(root, "app"), { recursive: true });
  mkdirSync(join(root, ".portable"), { recursive: true });
  mkdirSync(join(root, "runtime", "node"), { recursive: true });
  mkdirSync(join(root, "runtime", "native"), { recursive: true });
  writeFileSync(join(root, "Keiko.exe"), `launcher-${version}`, "utf8");
  writeFileSync(join(root, "runtime", "node", "node.exe"), "node", "utf8");
  const helper = "signed runtime supervisor";
  writeFileSync(join(root, "runtime", "native", "keiko-runtime-supervisor.exe"), helper, "utf8");
  writeFileSync(
    join(root, "app", "package.json"),
    JSON.stringify({ name: "@oscharko-dev/keiko", version }),
    "utf8",
  );
  writeFileSync(join(root, ".portable", "setup-manifest.json"), setupManifest(version), "utf8");
  writeFileSync(
    join(root, ".portable", "update-portable-manifest.json"),
    portableManifest(withSidecar),
    "utf8",
  );
  const sidecar = withSidecar ? sidecarFixture() : undefined;
  if (sidecar !== undefined) {
    for (const [path, bytes] of Object.entries(sidecar.files)) {
      const destination = join(root, SIDECAR_ROOT, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes, "utf8");
    }
  }
  writeFileSync(
    join(root, ".portable", "runtime-supervisor-qualification.json"),
    JSON.stringify({
      schemaVersion: 1,
      suiteVersion: "runtime-tree-qualification-v1",
      platformTarget: TARGET,
      sourceCommitSha: SOURCE_COMMIT_SHA,
      artifactSha256: ARTIFACT_SHA256,
      helperSha256: sha256(helper),
      sidecars:
        sidecar === undefined
          ? []
          : [{ name: "opencode-compatible", sha256: sidecar.payloadSha256 }],
      backend: "windows-job-object",
      result: "passed",
    }),
    "utf8",
  );
}

function stageSummary(withSidecar = false): UpdatePortableStagingSummary {
  return {
    stageId: "stage-1",
    status: "staged",
    target: TARGET,
    packageVersion: TARGET_VERSION,
    assetName: "keiko-windows-x64.zip",
    assetId: 1,
    releaseId: 2,
    sizeBytes: 3,
    sha256: ARTIFACT_SHA256,
    manifestSha256: sha256(portableManifest(withSidecar)),
  };
}

async function makeInstall(withSidecar = false): Promise<{
  readonly home: string;
  readonly stateDir: string;
  readonly managedRoot: string;
  readonly packageRoot: string;
  readonly stageRoot: string;
}> {
  const home = await mkdtemp(join(tmpdir(), "keiko-portable-activation-"));
  tempRoots.push(home);
  const managedRoot = join(home, "AppData", "Local", "Programs", "Keiko");
  const packageRoot = join(managedRoot, "app");
  const stageRoot = join(dirname(managedRoot), ".keiko-portable-updates", "stage-1", "Keiko");
  writeInstall(managedRoot, OLD_VERSION);
  writeInstall(stageRoot, TARGET_VERSION, withSidecar);
  writeFileSync(join(managedRoot, "active.txt"), "active", "utf8");
  return {
    home,
    stateDir: join(home, ".keiko"),
    managedRoot,
    packageRoot,
    stageRoot,
  };
}

function childProcess(): ChildProcess {
  return { unref: vi.fn() } as unknown as ChildProcess;
}

type QualificationMutation = "receipt-source" | "manifest" | "sidecar-bytes";

function mutateQualificationCandidate(root: string, mutation: QualificationMutation): void {
  if (mutation === "receipt-source") {
    const path = join(root, ".portable", "runtime-supervisor-qualification.json");
    const receipt = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    receipt.sourceCommitSha = "e".repeat(40);
    writeFileSync(path, JSON.stringify(receipt), "utf8");
    return;
  }
  if (mutation === "manifest") {
    const path = join(root, ".portable", "update-portable-manifest.json");
    writeFileSync(path, `${readFileSync(path, "utf8")} `, "utf8");
    return;
  }
  writeFileSync(join(root, SIDECAR_ROOT, "opencode.cmd"), "mutated sidecar", "utf8");
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("portable update activation", () => {
  it.each([
    "",
    ".",
    "..",
    "nested/stage",
    "nested\\stage",
    "/absolute",
    "C:\\stage",
    "bad\u0000id",
  ])("rejects unsafe stage id %j before install or registration mutation", async (stageId) => {
    const install = await makeInstall();
    const registrationPath = join(install.stateDir, "portable-install-state.json");
    mkdirSync(install.stateDir, { recursive: true });
    writeFileSync(registrationPath, "old-registration\n", "utf8");
    const activator = createPortableUpdateActivator({
      env: { KEIKO_STATE_DIR: install.stateDir },
      homedir: () => install.home,
      spawnFn: () => childProcess(),
      versionVerifier: () => Promise.resolve(true),
    });

    await expect(
      activator.activate({
        sessionId: "unsafe-stage",
        targetVersion: TARGET_VERSION,
        stage: { ...stageSummary(), stageId },
        runtimeFacts: { packageRoot: install.packageRoot, portableStateDir: install.stateDir },
      }),
    ).rejects.toMatchObject({ reason: "portable-activation-failed" });
    expect(readFileSync(join(install.packageRoot, "package.json"), "utf8")).toContain(OLD_VERSION);
    expect(readFileSync(registrationPath, "utf8")).toBe("old-registration\n");
  });

  it.each([
    "",
    ".",
    "..",
    "nested/stage",
    "nested\\stage",
    "/absolute",
    "C:\\stage",
    "bad\u0000id",
  ])("rejects unsafe recovery stage id %j", async (stageId) => {
    const install = await makeInstall();
    mkdirSync(join(install.stateDir, "updates"), { recursive: true });
    writeFileSync(
      join(install.stateDir, "updates", "portable-activation-recovery.json"),
      JSON.stringify({ activationId: "a".repeat(32), stageId, target: TARGET, phase: "prepared" }),
      "utf8",
    );

    expect(() => readPortableActivationRecovery(install.stateDir)).toThrow(
      "portable activation recovery metadata is malformed",
    );
    expect(readFileSync(join(install.packageRoot, "package.json"), "utf8")).toContain(OLD_VERSION);
  });

  it("promotes the staged install, refreshes registration, relaunches, and records redacted state", async () => {
    const install = await makeInstall();
    const localState = createUpdateLocalStateManager({ stateDir: install.stateDir });
    const spawnCalls: [string, readonly string[], SpawnOptions][] = [];
    const spawnFn = vi.fn((command: string, args: readonly string[], options: SpawnOptions) => {
      spawnCalls.push([command, args, options]);
      return childProcess();
    });
    const activator = createPortableUpdateActivator({
      env: {
        KEIKO_STATE_DIR: install.stateDir,
        APPDATA: join(install.home, "AppData", "Roaming"),
        LOCALAPPDATA: join(install.home, "AppData", "Local"),
      },
      homedir: () => install.home,
      localState,
      now: () => Date.parse("2026-07-06T00:00:00.000Z"),
      spawnFn,
      versionVerifier: () => Promise.resolve(true),
    });

    const activation = await activator.activate({
      sessionId: "session-1",
      targetVersion: TARGET_VERSION,
      stage: stageSummary(),
      runtimeFacts: { packageRoot: install.packageRoot, portableStateDir: install.stateDir },
    });

    expect(activation).toMatchObject({
      status: "activated",
      packageVersion: TARGET_VERSION,
      registrationRefreshed: true,
      relaunchRequested: true,
      versionVerified: true,
    });
    expect(readFileSync(join(install.packageRoot, "package.json"), "utf8")).toContain(
      TARGET_VERSION,
    );
    expect(existsSync(join(install.managedRoot, "active.txt"))).toBe(false);
    expect(spawnCalls[0]?.[0]).toBe(join(install.managedRoot, "Keiko.exe"));
    expect(readFileSync(join(install.stateDir, "portable-install-state.json"), "utf8")).toContain(
      TARGET_VERSION,
    );
    const runtimeState = JSON.stringify(localState.readRuntimeState());
    expect(runtimeState).toContain("portableActivation");
    expect(runtimeState).not.toContain(install.managedRoot);
    const audit = readFileSync(join(install.stateDir, "updates", "update-audit.jsonl"), "utf8");
    expect(audit).toContain("portable-activation-result");
    expect(audit).toContain("portable-relaunch-result");
    expect(audit).not.toContain(install.managedRoot);
  });

  it("restores the previously working install and retains staging when relaunch version is not verified", async () => {
    const install = await makeInstall();
    const registrationPath = join(install.stateDir, "portable-install-state.json");
    mkdirSync(install.stateDir, { recursive: true });
    writeFileSync(registrationPath, '{"packageVersion":"0.2.14"}\n', "utf8");
    const localState = createUpdateLocalStateManager({ stateDir: install.stateDir });
    const activator = createPortableUpdateActivator({
      env: {
        KEIKO_STATE_DIR: install.stateDir,
        APPDATA: join(install.home, "AppData", "Roaming"),
        LOCALAPPDATA: join(install.home, "AppData", "Local"),
      },
      homedir: () => install.home,
      localState,
      spawnFn: () => childProcess(),
      versionVerifier: () => Promise.resolve(false),
    });

    await expect(
      activator.activate({
        sessionId: "session-version-miss",
        targetVersion: TARGET_VERSION,
        stage: stageSummary(),
        runtimeFacts: { packageRoot: install.packageRoot, portableStateDir: install.stateDir },
      }),
    ).rejects.toMatchObject({ reason: "portable-version-verification-failed" });
    expect(readFileSync(join(install.packageRoot, "package.json"), "utf8")).toContain(OLD_VERSION);
    expect(readFileSync(join(install.managedRoot, "active.txt"), "utf8")).toBe("active");
    expect(readFileSync(registrationPath, "utf8")).toBe('{"packageVersion":"0.2.14"}\n');
    expect(readFileSync(join(install.stageRoot, "app", "package.json"), "utf8")).toContain(
      TARGET_VERSION,
    );
    expect(localState.readRuntimeState().portableActivation).toBeUndefined();
    const audit = readFileSync(join(install.stateDir, "updates", "update-audit.jsonl"), "utf8");
    expect(audit).toContain("portable-activation-result");
    expect(audit).toContain('"status":"failed"');
    expect(audit).not.toContain("portable-relaunch-result");
    expect(audit).not.toContain(install.managedRoot);
    expect(existsSync(join(install.stateDir, "updates", "portable-activation-recovery.json"))).toBe(
      false,
    );
  });

  it("refreshes a quoted Windows shortcut when the managed launcher path contains spaces", async () => {
    const base = await mkdtemp(join(tmpdir(), "keiko-portable-activation-"));
    tempRoots.push(base);
    const home = join(base, "User Profile");
    const managedRoot = join(home, "AppData", "Local", "Programs", "Keiko App");
    const packageRoot = join(managedRoot, "app");
    const stageRoot = join(dirname(managedRoot), ".keiko-portable-updates", "stage-1", "Keiko");
    const stateDir = join(home, ".keiko");
    writeInstall(managedRoot, OLD_VERSION);
    writeInstall(stageRoot, TARGET_VERSION);
    const activator = createPortableUpdateActivator({
      env: {
        KEIKO_STATE_DIR: stateDir,
        APPDATA: join(home, "AppData", "Roaming"),
        LOCALAPPDATA: join(home, "AppData", "Local"),
      },
      homedir: () => home,
      spawnFn: () => childProcess(),
      versionVerifier: () => Promise.resolve(true),
    });

    await activator.activate({
      sessionId: "session-spaced-shortcut",
      targetVersion: TARGET_VERSION,
      stage: stageSummary(),
      runtimeFacts: { packageRoot, portableStateDir: stateDir },
    });

    const shortcutPath = join(
      home,
      "AppData",
      "Roaming",
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Keiko.bat",
    );
    expect(readFileSync(shortcutPath, "utf8")).toBe(
      `@start "" "${join(managedRoot, "Keiko.exe")}" start --open\r\n`,
    );
  });

  it("fails closed and preserves the active install when the staged candidate is incomplete", async () => {
    const install = await makeInstall();
    await rm(join(install.stageRoot, "Keiko.exe"), { force: true });
    const activator = createPortableUpdateActivator({
      env: { KEIKO_STATE_DIR: install.stateDir },
      homedir: () => install.home,
      localState: createUpdateLocalStateManager({ stateDir: install.stateDir }),
      spawnFn: () => childProcess(),
      versionVerifier: () => Promise.resolve(true),
    });

    await expect(
      activator.activate({
        sessionId: "session-2",
        targetVersion: TARGET_VERSION,
        stage: stageSummary(),
        runtimeFacts: { packageRoot: install.packageRoot, portableStateDir: install.stateDir },
      }),
    ).rejects.toMatchObject({ reason: "portable-activation-failed" });
    expect(readFileSync(join(install.packageRoot, "package.json"), "utf8")).toContain(OLD_VERSION);
    expect(readFileSync(join(install.managedRoot, "active.txt"), "utf8")).toBe("active");
    expect(existsSync(join(install.stateDir, "portable-install-state.json"))).toBe(false);
  });

  it.each<QualificationMutation>(["receipt-source", "manifest", "sidecar-bytes"])(
    "fails closed before promotion when %s qualification evidence changes after staging",
    async (mutation) => {
      const withSidecar = mutation === "sidecar-bytes";
      const install = await makeInstall(withSidecar);
      mutateQualificationCandidate(install.stageRoot, mutation);
      const activator = createPortableUpdateActivator({
        env: { KEIKO_STATE_DIR: install.stateDir },
        homedir: () => install.home,
        spawnFn: () => childProcess(),
        versionVerifier: () => Promise.resolve(true),
      });

      await expect(
        activator.activate({
          sessionId: `qualification-${mutation}`,
          targetVersion: TARGET_VERSION,
          stage: stageSummary(withSidecar),
          runtimeFacts: { packageRoot: install.packageRoot, portableStateDir: install.stateDir },
        }),
      ).rejects.toMatchObject({ reason: "portable-activation-failed" });
      expect(readFileSync(join(install.packageRoot, "package.json"), "utf8")).toContain(
        OLD_VERSION,
      );
      expect(readFileSync(join(install.managedRoot, "active.txt"), "utf8")).toBe("active");
    },
  );

  it("restores the active install when registration refresh fails before relaunch", async () => {
    const install = await makeInstall();
    const unsafeStateTarget = join(install.home, "unsafe-state-target");
    mkdirSync(unsafeStateTarget);
    mkdirSync(install.stateDir);
    symlinkSync(unsafeStateTarget, join(install.stateDir, "portable-install-state.json"), "file");
    const spawnFn = vi.fn(() => childProcess());
    const activator = createPortableUpdateActivator({
      env: { KEIKO_STATE_DIR: install.stateDir },
      homedir: () => install.home,
      spawnFn,
      versionVerifier: () => Promise.resolve(true),
    });

    await expect(
      activator.activate({
        sessionId: "session-3",
        targetVersion: TARGET_VERSION,
        stage: stageSummary(),
        runtimeFacts: { packageRoot: install.packageRoot, portableStateDir: install.stateDir },
      }),
    ).rejects.toMatchObject({ reason: "portable-activation-failed" });
    expect(spawnFn).not.toHaveBeenCalled();
    expect(readFileSync(join(install.packageRoot, "package.json"), "utf8")).toContain(OLD_VERSION);
    expect(readFileSync(join(install.managedRoot, "active.txt"), "utf8")).toBe("active");
    expect(readFileSync(join(install.stageRoot, "app", "package.json"), "utf8")).toContain(
      TARGET_VERSION,
    );
  });

  it("restores the active install when relaunch cannot be started", async () => {
    const install = await makeInstall();
    const registrationPath = join(install.stateDir, "portable-install-state.json");
    mkdirSync(install.stateDir, { recursive: true });
    writeFileSync(registrationPath, '{"packageVersion":"0.2.14"}\n', "utf8");
    const activator = createPortableUpdateActivator({
      env: { KEIKO_STATE_DIR: install.stateDir },
      homedir: () => install.home,
      spawnFn: () => {
        throw new Error("launcher unavailable");
      },
      versionVerifier: () => Promise.resolve(true),
    });

    await expect(
      activator.activate({
        sessionId: "session-relaunch-failed",
        targetVersion: TARGET_VERSION,
        stage: stageSummary(),
        runtimeFacts: { packageRoot: install.packageRoot, portableStateDir: install.stateDir },
      }),
    ).rejects.toMatchObject({ reason: "portable-relaunch-failed" });
    expect(readFileSync(join(install.packageRoot, "package.json"), "utf8")).toContain(OLD_VERSION);
    expect(readFileSync(join(install.managedRoot, "active.txt"), "utf8")).toBe("active");
    expect(readFileSync(registrationPath, "utf8")).toBe('{"packageVersion":"0.2.14"}\n');
    expect(readFileSync(join(install.stageRoot, "app", "package.json"), "utf8")).toContain(
      TARGET_VERSION,
    );
  });

  it("blocks a concurrent promotion until the active activation has settled", async () => {
    const install = await makeInstall();
    let completeVerification: (() => void) | undefined;
    const verification = new Promise<boolean>((resolve) => {
      completeVerification = (): void => {
        resolve(true);
      };
    });
    const activator = createPortableUpdateActivator({
      env: { KEIKO_STATE_DIR: install.stateDir },
      homedir: () => install.home,
      spawnFn: () => childProcess(),
      versionVerifier: () => verification,
    });
    const request = {
      sessionId: "session-concurrent",
      targetVersion: TARGET_VERSION,
      stage: stageSummary(),
      runtimeFacts: { packageRoot: install.packageRoot, portableStateDir: install.stateDir },
    };

    const first = activator.activate(request);
    const concurrentActivator = createPortableUpdateActivator({
      env: { KEIKO_STATE_DIR: install.stateDir },
      homedir: () => install.home,
      spawnFn: () => childProcess(),
      versionVerifier: () => Promise.resolve(true),
    });
    await expect(concurrentActivator.activate(request)).rejects.toMatchObject({
      reason: "portable-activation-failed",
    });
    completeVerification?.();
    await expect(first).resolves.toMatchObject({ status: "activated" });
  });

  it("settles an interrupted promotion from content-free recovery metadata before promoting", async () => {
    const install = await makeInstall();
    const request = {
      sessionId: "session-interrupted",
      targetVersion: TARGET_VERSION,
      stage: stageSummary(),
      runtimeFacts: { packageRoot: install.packageRoot, portableStateDir: install.stateDir },
    };
    const activationId = activationIdFor(request);
    const backupRoot = join(dirname(install.managedRoot), `.keiko-previous-${activationId}`);
    renameSync(install.managedRoot, backupRoot);
    renameSync(install.stageRoot, install.managedRoot);
    mkdirSync(join(install.stateDir, "updates"), { recursive: true });
    writeFileSync(
      join(install.stateDir, "updates", "portable-activation-recovery.json"),
      JSON.stringify({ activationId, stageId: "stage-1", target: TARGET, phase: "promoted" }),
      "utf8",
    );
    const activator = createPortableUpdateActivator({
      env: { KEIKO_STATE_DIR: install.stateDir },
      homedir: () => install.home,
      spawnFn: () => childProcess(),
      versionVerifier: () => Promise.resolve(true),
    });

    await expect(activator.activate(request)).resolves.toMatchObject({ status: "activated" });
    expect(readFileSync(join(install.packageRoot, "package.json"), "utf8")).toContain(
      TARGET_VERSION,
    );
    expect(existsSync(backupRoot)).toBe(false);
    expect(existsSync(join(install.stateDir, "updates", "portable-activation-recovery.json"))).toBe(
      false,
    );
  });

  it("restores prior registration for an interrupted registered candidate before failing safely", async () => {
    const install = await makeInstall();
    const request = {
      sessionId: "session-registered-recovery",
      targetVersion: TARGET_VERSION,
      stage: stageSummary(),
      runtimeFacts: { packageRoot: install.packageRoot, portableStateDir: install.stateDir },
    };
    const registrationPath = join(install.stateDir, "portable-install-state.json");
    const oldRegistration = '{"packageVersion":"0.2.14"}\n';
    mkdirSync(install.stateDir, { recursive: true });
    writeFileSync(registrationPath, oldRegistration, "utf8");
    const activationId = activationIdFor(request);
    capturePortableRegistration({ stateDir: install.stateDir, activationId });
    const backupRoot = join(dirname(install.managedRoot), `.keiko-previous-${activationId}`);
    renameSync(install.managedRoot, backupRoot);
    renameSync(install.stageRoot, install.managedRoot);
    writeFileSync(registrationPath, '{"packageVersion":"0.2.12"}\n', "utf8");
    mkdirSync(join(install.stateDir, "updates"), { recursive: true });
    writeFileSync(
      join(install.stateDir, "updates", "portable-activation-recovery.json"),
      JSON.stringify({ activationId, stageId: "stage-1", target: TARGET, phase: "registered" }),
      "utf8",
    );
    await rm(join(install.managedRoot, "Keiko.exe"), { force: true });
    const activator = createPortableUpdateActivator({
      env: { KEIKO_STATE_DIR: install.stateDir },
      homedir: () => install.home,
      spawnFn: () => childProcess(),
      versionVerifier: () => Promise.resolve(true),
    });

    await expect(activator.activate(request)).rejects.toMatchObject({
      reason: "portable-activation-failed",
    });
    expect(readFileSync(join(install.packageRoot, "package.json"), "utf8")).toContain(OLD_VERSION);
    expect(readFileSync(registrationPath, "utf8")).toBe(oldRegistration);
  });
});
