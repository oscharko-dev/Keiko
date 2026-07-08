import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { validateCodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts";
import type {
  CodingWorkbenchActionClass,
  CodingWorkbenchConnectorScope,
  CodingWorkbenchPermissionRequestKind,
} from "@oscharko-dev/keiko-contracts";
import type { CodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts";

import {
  createCodingRuntimeManager,
  resolveCodingRuntimeSidecarLaunchTarget,
  type CodingRuntimeLaunchRequest,
  type CodingRuntimeSpawnFn,
  type CodingRuntimeSpawnHandle,
} from "./codingRuntimeManager.js";
import type { PortableSidecarRuntimeVerification } from "../update-portable-sidecar-verification.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function executable(root: string, name = "opencode-sidecar"): string {
  mkdirSync(root, { recursive: true });
  const path = join(root, name);
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
}

interface FakeChild {
  readonly handle: CodingRuntimeSpawnHandle;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly kills: NodeJS.Signals[];
  exit(code?: number | null): void;
  error(error: Error): void;
}

function fakeChild(): FakeChild {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kills: NodeJS.Signals[] = [];
  let onExit: ((code: number | null) => void) | undefined;
  let onError: ((error: Error) => void) | undefined;
  return {
    stdout,
    stderr,
    kills,
    handle: {
      stdout,
      stderr,
      pid: 4242,
      kill: (signal): void => {
        kills.push(signal);
      },
      onExit: (callback): void => {
        onExit = callback;
      },
      onError: (callback): void => {
        onError = callback;
      },
    },
    exit: (code = 0): void => {
      onExit?.(code);
      stdout.end();
      stderr.end();
    },
    error: (error): void => {
      onError?.(error);
    },
  };
}

function launchRequest(
  workspaceRoot: string,
  managedRoot: string,
  executablePath: string,
): CodingRuntimeLaunchRequest {
  return {
    runId: "run-1988",
    taskRef: "issue-1988",
    adapterKind: "opencode-compatible",
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
    requestedMode: "supervised-coding",
    effectiveMode: "supervised-coding",
    workspaceRoot,
    executablePath,
    managedRoot,
    gatewayUrl: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
    modelProfileId: "coding-safe-openai-compatible",
    args: ["--stdio"],
    inheritedEnvAllowlist: ["PATH"],
    shutdownTimeoutMs: 5,
    startTimeoutMs: 30_000,
  };
}

function governedAssistRequest(
  workspaceRoot: string,
  managedRoot: string,
  executablePath: string,
): CodingRuntimeLaunchRequest {
  return {
    ...launchRequest(workspaceRoot, managedRoot, executablePath),
    runId: "run-1991",
    taskRef: "issue-1991",
    requestedMode: "governed-assist",
    effectiveMode: "governed-assist",
  };
}

function createManagedFixture(): {
  readonly workspaceRoot: string;
  readonly managedRoot: string;
  readonly executablePath: string;
} {
  const workspaceRoot = tempDir("keiko-runtime-workspace-");
  const managedRoot = tempDir("keiko-runtime-managed-");
  return { workspaceRoot, managedRoot, executablePath: executable(managedRoot) };
}

function createSpawnHarness(): {
  readonly spawn: CodingRuntimeSpawnFn;
  readonly children: FakeChild[];
  readonly captures: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly env: Record<string, string>;
    readonly cwd: string;
  }[];
} {
  const children: FakeChild[] = [];
  const captures: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly env: Record<string, string>;
    readonly cwd: string;
  }[] = [];
  const spawn: CodingRuntimeSpawnFn = (executablePath, args, env, cwd) => {
    const child = fakeChild();
    children.push(child);
    captures.push({ executable: executablePath, args, env, cwd });
    return child.handle;
  };
  return { spawn, children, captures };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

interface PermissionLineInput {
  readonly requestId: string;
  readonly kind: CodingWorkbenchPermissionRequestKind;
  readonly actionClass: CodingWorkbenchActionClass;
  readonly reasonCode: string;
  readonly actionKind?: string | undefined;
  readonly scopeLabel?: string | undefined;
  readonly risk?: string | undefined;
  readonly policyReason?: string | undefined;
  readonly commandLabel?: string | undefined;
  readonly connectorScopes?: readonly CodingWorkbenchConnectorScope[] | undefined;
  readonly targetPath?: string | undefined;
  readonly allowedRelativePaths?: readonly string[] | undefined;
  readonly fileCount?: number | undefined;
  readonly addedLines?: number | undefined;
  readonly deletedLines?: number | undefined;
  readonly executable?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly passedCount?: number | undefined;
  readonly failedCount?: number | undefined;
  readonly skippedCount?: number | undefined;
  readonly scopeDigest?: string | undefined;
  readonly approvalToken?: ApprovalClaimInput | undefined;
  readonly operatorStopped?: boolean | undefined;
}

interface ApprovalClaimInput {
  readonly approvalId: string;
  readonly approvalToken: string;
}

function permissionLine(input: PermissionLineInput): string {
  return `${JSON.stringify({
    type: "permission-request",
    expiresAt: "2026-07-07T13:05:00.000Z",
    ...input,
  })}\n`;
}

function pushPermissionLine(
  requestId: string,
  approvalToken?: ApprovalClaimInput,
  operatorStopped?: boolean,
): string {
  return permissionLine({
    requestId,
    kind: "delivery-substrate",
    actionClass: "delivery-substrate",
    reasonCode: "approval-required",
    actionKind: "push",
    scopeLabel: "workspace-scope",
    risk: "high",
    policyReason: "approval-required",
    commandLabel: "push",
    ...(approvalToken === undefined ? {} : { approvalToken }),
    ...(operatorStopped === undefined ? {} : { operatorStopped }),
  });
}

describe("coding runtime manager", () => {
  it("resolves launch paths from a verified portable sidecar payload", () => {
    const managedInstallRoot = tempDir("keiko-runtime-install-");
    const sidecarRoot = join(managedInstallRoot, "runtime", "sidecars", "opencode-adapter");
    const executablePath = executable(sidecarRoot);
    const sidecar: PortableSidecarRuntimeVerification = {
      payloadRootPath: "runtime/sidecars/opencode-adapter",
      executablePath: "runtime/sidecars/opencode-adapter/opencode-sidecar",
      licenseEvidencePath: "runtime/sidecars/opencode-adapter/LICENSE.evidence.json",
      licenseEvidenceSha256: "a".repeat(64),
      sbomEvidencePath: "runtime/sidecars/opencode-adapter/sbom.evidence.json",
      sbomEvidenceSha256: "b".repeat(64),
      summary: {
        name: "opencode-adapter",
        kind: "opencode-compatible",
        upstreamName: "opencode",
        upstreamVersion: "1.0.0",
        adapterName: "keiko-opencode-adapter",
        adapterVersion: "1.0.0",
        protocolVersion: "1",
        platformTarget: "macos-arm64",
        payloadSha256: "c".repeat(64),
        payloadSha256Prefix: "c".repeat(12),
        sizeBytes: 12,
        status: "verified",
      },
    };

    const result = resolveCodingRuntimeSidecarLaunchTarget(managedInstallRoot, sidecar);

    expect(result).toEqual({
      ok: true,
      target: {
        managedRoot: sidecarRoot,
        executablePath,
        runtimeName: "opencode-adapter",
        payloadSha256Prefix: "c".repeat(12),
      },
    });
  });

  it("refuses an executable that is not inside the managed sidecar root", () => {
    const fixture = createManagedFixture();
    const unmanaged = executable(tempDir("keiko-runtime-unmanaged-"));
    const harness = createSpawnHarness();
    const manager = createCodingRuntimeManager({
      spawn: harness.spawn,
      processEnv: { PATH: "/usr/bin", CODEX_ACCESS_TOKEN: "super-secret-token" },
    });

    const result = manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, unmanaged),
    );

    expect(result).toEqual({
      ok: false,
      failureCode: "sidecar-unmanaged",
      retryable: false,
    });
    expect(harness.children).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(fixture.managedRoot);
    expect(JSON.stringify(result)).not.toContain(unmanaged);
  });

  it("fails closed when OpenCode is paired with a Codex subscription profile", () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const manager = createCodingRuntimeManager({ spawn: harness.spawn, processEnv: {} });
    const request: CodingRuntimeLaunchRequest = {
      ...launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
      modelSource: "chatgpt-codex-subscription-profile",
    };

    const result = manager.start(request);

    expect(result).toEqual({
      ok: false,
      failureCode: "adapter-profile-mismatch",
      retryable: false,
    });
    expect(harness.children).toHaveLength(0);
  });

  it("starts a managed sidecar with only allowlisted inherited env and runtime projection", () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const manager = createCodingRuntimeManager({
      spawn: harness.spawn,
      processEnv: {
        PATH: "/usr/bin",
        OPENAI_API_KEY: "provider-secret-key",
        CODEX_ACCESS_TOKEN: "subscription-secret-token",
      },
    });

    const result = manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );

    expect(result).toMatchObject({ ok: true, runId: "run-1988", status: "ready" });
    expect(manager.health()).toMatchObject({ status: "ready", activeRunId: "run-1988" });
    expect(harness.captures).toHaveLength(1);
    expect(harness.captures[0]?.env).toMatchObject({
      PATH: "/usr/bin",
      KEIKO_CODING_RUN_ID: "run-1988",
      KEIKO_CODING_TASK_REF: "issue-1988",
      KEIKO_CODING_ADAPTER_KIND: "opencode-compatible",
      KEIKO_CODING_RUNTIME_SOURCE: "keiko-sidecar",
      KEIKO_CODING_MODEL_SOURCE: "keiko-model-gateway",
      KEIKO_CODING_MODE: "supervised-coding",
      KEIKO_CODING_WORKSPACE_ROOT: fixture.workspaceRoot,
      KEIKO_MODEL_GATEWAY_URL: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
      KEIKO_MODEL_PROFILE_ID: "coding-safe-openai-compatible",
    });
    expect(Object.values(harness.captures[0]?.env ?? {})).not.toContain("provider-secret-key");
    expect(Object.values(harness.captures[0]?.env ?? {})).not.toContain(
      "subscription-secret-token",
    );
  });

  it("rejects non-loopback gateway URLs before spawn", () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const manager = createCodingRuntimeManager({ spawn: harness.spawn, processEnv: {} });
    const request = {
      ...launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
      gatewayUrl: "https://provider.example/v1",
    };

    const result = manager.start(request);

    expect(result).toEqual({
      ok: false,
      failureCode: "gateway-non-loopback",
      retryable: false,
    });
    expect(harness.children).toHaveLength(0);
  });

  it("stops the active sidecar and allows a clean restart", async () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const manager = createCodingRuntimeManager({ spawn: harness.spawn, processEnv: {} });

    manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    const stop = manager.stop("run-1988");
    harness.children[0]?.exit(0);
    await stop;
    const restart = manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );

    expect(harness.children[0]?.kills).toEqual(["SIGTERM"]);
    expect(manager.health()).toMatchObject({ status: "ready", activeRunId: "run-1988" });
    expect(restart).toMatchObject({ ok: true, status: "ready" });
    expect(harness.children).toHaveLength(2);
  });

  it("marks crashes as restart-denied without respawning implicitly", () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const manager = createCodingRuntimeManager({ spawn: harness.spawn, processEnv: {} });

    manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    harness.children[0]?.exit(1);

    expect(manager.health()).toEqual({
      status: "restart-denied",
      activeRunId: "run-1988",
      failureCode: "runtime-crashed",
      restartDenied: true,
    });
    expect(harness.children).toHaveLength(1);
  });

  it("normalizes permission requests from the sidecar stream into content-free runtime events", async () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const events: CodingWorkbenchRuntimeEvent[] = [];
    const manager = createCodingRuntimeManager({
      spawn: harness.spawn,
      processEnv: {},
      onRuntimeEvent: (event) => {
        events.push(event);
      },
      nowIso: () => "2026-07-07T13:00:00.000Z",
    });

    manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    harness.children[0]?.stdout.write(
      `${JSON.stringify({
        type: "permission-request",
        requestId: "perm-1988",
        kind: "command-execution",
        actionClass: "command-execution",
        reasonCode: "command-execution",
        commandLabel: "npm",
        expiresAt: "2026-07-07T13:05:00.000Z",
      })}\n`,
    );
    await settle();

    const permissionEvent = events.find((event) => event.kind === "permission-requested");
    expect(permissionEvent).toMatchObject({
      schemaVersion: "1",
      runId: "run-1988",
      kind: "permission-requested",
      permissionRequest: {
        requestId: "perm-1988",
        kind: "command-execution",
        actionClass: "command-execution",
        reasonCode: "command-execution",
        commandLabel: "npm",
      },
    });
    expect(validateCodingWorkbenchRuntimeEvent(permissionEvent).ok).toBe(true);
    expect(JSON.stringify(permissionEvent)).not.toContain(fixture.workspaceRoot);
  });

  it("carries Supervised Coding prompt metadata through permission events", async () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const events: CodingWorkbenchRuntimeEvent[] = [];
    const manager = createCodingRuntimeManager({
      spawn: harness.spawn,
      processEnv: {},
      onRuntimeEvent: (event) => {
        events.push(event);
      },
      nowIso: () => "2026-07-07T13:00:00.000Z",
    });

    manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    harness.children[0]?.stdout.write(
      permissionLine({
        requestId: "perm-1992-push",
        kind: "delivery-substrate",
        actionClass: "delivery-substrate",
        reasonCode: "approval-required",
        actionKind: "push",
        scopeLabel: "workspace-scope",
        risk: "high",
        policyReason: "approval-required",
        scopeDigest: "a".repeat(64),
      }),
    );
    await settle();

    const permissionEvent = events.find((event) => event.kind === "permission-requested");
    expect(permissionEvent).toMatchObject({
      permissionRequest: {
        requestId: "perm-1992-push",
        actionKind: "push",
        scopeLabel: "workspace-scope",
        risk: "high",
        policyReason: "approval-required",
      },
    });
    expect(validateCodingWorkbenchRuntimeEvent(permissionEvent).ok).toBe(true);
    expect(JSON.stringify(permissionEvent)).not.toMatch(/diff --git|stdout|stderr|\/tmp/u);
  });

  it("enforces supervised file-edit scope before emitting a runtime event", async () => {
    const fixture = createManagedFixture();
    mkdirSync(join(fixture.workspaceRoot, "src"), { recursive: true });
    writeFileSync(join(fixture.workspaceRoot, "src", "allowed.ts"), "export const ok = true;\n");
    const harness = createSpawnHarness();
    const events: CodingWorkbenchRuntimeEvent[] = [];
    const manager = createCodingRuntimeManager({
      spawn: harness.spawn,
      processEnv: {},
      onRuntimeEvent: (event) => {
        events.push(event);
      },
      nowIso: () => "2026-07-07T13:00:00.000Z",
    });

    manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    harness.children[0]?.stdout.write(
      permissionLine({
        requestId: "perm-1992-file-accepted",
        kind: "workspace-write",
        actionClass: "workspace-write",
        reasonCode: "scoped-file-edit",
        actionKind: "file-edit",
        scopeLabel: "workspace-scope",
        risk: "medium",
        policyReason: "scoped-file-edit",
        targetPath: "src/allowed.ts",
        allowedRelativePaths: ["src"],
        fileCount: 1,
        addedLines: 2,
        deletedLines: 0,
      }),
    );
    harness.children[0]?.stdout.write(
      permissionLine({
        requestId: "perm-1992-file-denied",
        kind: "workspace-write",
        actionClass: "workspace-write",
        reasonCode: "scoped-file-edit",
        actionKind: "file-edit",
        scopeLabel: "workspace-scope",
        risk: "medium",
        policyReason: "scoped-file-edit",
        targetPath: "../escape.ts",
        allowedRelativePaths: ["src"],
        fileCount: 1,
        addedLines: 2,
        deletedLines: 0,
      }),
    );
    await settle();

    expect(events.find((event) => event.kind === "diff-summarized")).toMatchObject({
      fileCount: 1,
      addedLines: 2,
      deletedLines: 0,
    });
    expect(events.find((event) => event.failureCode === "out-of-scope-file-edit")).toMatchObject({
      kind: "failure-redacted",
      failureSummary: "out-of-scope-file-edit",
      retryable: false,
    });
    expect(events.some((event) => event.kind === "permission-requested")).toBe(false);
    expect(JSON.stringify(events)).not.toContain(fixture.workspaceRoot);
  });

  it("enforces supervised verification command allowlist before emitting summaries", async () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const events: CodingWorkbenchRuntimeEvent[] = [];
    const manager = createCodingRuntimeManager({
      spawn: harness.spawn,
      processEnv: {},
      onRuntimeEvent: (event) => {
        events.push(event);
      },
      nowIso: () => "2026-07-07T13:00:00.000Z",
    });

    manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    harness.children[0]?.stdout.write(
      permissionLine({
        requestId: "perm-1992-verification-command-accepted",
        kind: "command-execution",
        actionClass: "command-execution",
        reasonCode: "allowlisted-verification-command",
        actionKind: "verification-command",
        scopeLabel: "workspace-scope",
        risk: "low",
        policyReason: "allowlisted-verification-command",
        commandLabel: "verification-command",
        executable: "npm",
        args: ["run", "typecheck"],
        passedCount: 12,
        failedCount: 0,
        skippedCount: 0,
      }),
    );
    harness.children[0]?.stdout.write(
      permissionLine({
        requestId: "perm-1992-verification-command-denied",
        kind: "command-execution",
        actionClass: "command-execution",
        reasonCode: "allowlisted-verification-command",
        actionKind: "verification-command",
        scopeLabel: "workspace-scope",
        risk: "high",
        policyReason: "allowlisted-verification-command",
        commandLabel: "commit",
        executable: "git",
        args: ["commit"],
      }),
    );
    await settle();

    expect(events.find((event) => event.kind === "verification-summarized")).toMatchObject({
      verificationKind: "verification-command",
      verificationStatus: "passed",
      passedCount: 12,
      failedCount: 0,
      skippedCount: 0,
    });
    expect(events.find((event) => event.failureCode === "mutating-command-denied")).toMatchObject({
      kind: "failure-redacted",
      failureSummary: "mutating-command-denied",
      retryable: false,
    });
    expect(events.some((event) => event.kind === "permission-requested")).toBe(false);
    expect(JSON.stringify(events)).not.toMatch(/stdout|stderr|npm run typecheck/u);
  });

  it("enforces supervised delivery approval provenance before allowing mutations", async () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const events: CodingWorkbenchRuntimeEvent[] = [];
    const manager = createCodingRuntimeManager({
      spawn: harness.spawn,
      processEnv: {},
      now: () => 1_000,
      onRuntimeEvent: (event) => {
        events.push(event);
      },
      nowIso: () => "2026-07-07T13:00:00.000Z",
    });

    manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    const issued = manager.issueApproval({
      runId: "run-1988",
      requestId: "perm-1992-push-accepted",
      actionKind: "push",
      approvedByUserId: "operator",
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error("expected approval issue to succeed");
    const forged = {
      approvalId: "sca_forgedapproval000000000000000000",
      approvalToken: "f".repeat(64),
    };

    harness.children[0]?.stdout.write(pushPermissionLine("perm-1992-push-missing"));
    harness.children[0]?.stdout.write(pushPermissionLine("perm-1992-push-stale", forged));
    harness.children[0]?.stdout.write(
      pushPermissionLine("perm-1992-push-stopped", undefined, true),
    );
    harness.children[0]?.stdout.write(
      pushPermissionLine("perm-1992-push-accepted", issued.approval),
    );
    harness.children[0]?.stdout.write(
      pushPermissionLine("perm-1992-push-accepted", issued.approval),
    );
    await settle();

    expect(events.find((event) => event.kind === "permission-requested")).toMatchObject({
      permissionRequest: {
        requestId: "perm-1992-push-missing",
        actionKind: "push",
        policyReason: "approval-required",
      },
    });
    const staleFailures = events.filter((event) => event.failureCode === "approval-proof-stale");
    expect(staleFailures).toHaveLength(2);
    expect(events.find((event) => event.failureCode === "operator-stopped")).toMatchObject({
      kind: "failure-redacted",
      failureSummary: "operator-stopped",
      retryable: false,
    });
    expect(events.find((event) => event.kind === "artifact-produced")).toMatchObject({
      artifactKind: "approval",
      artifactLabel: "approval-proof-accepted",
      artifactDigest: issued.approvalDigest,
      artifactBytes: 0,
    });
    expect(JSON.stringify(events)).not.toContain(issued.approval.approvalToken);
  });

  it("binds supervised approvals to manager-computed action and connector scope", async () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const events: CodingWorkbenchRuntimeEvent[] = [];
    const manager = createCodingRuntimeManager({
      spawn: harness.spawn,
      processEnv: {},
      now: () => 1_000,
      onRuntimeEvent: (event) => {
        events.push(event);
      },
      nowIso: () => "2026-07-07T13:00:00.000Z",
    });

    manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    const pushApproval = manager.issueApproval({
      runId: "run-1988",
      requestId: "perm-1992-push-merge",
      actionKind: "push",
      approvedByUserId: "operator",
    });
    const externalApproval = manager.issueApproval({
      runId: "run-1988",
      requestId: "perm-1992-external-write-source-control",
      actionKind: "external-write",
      connectorScopes: ["issue-tracker.write"],
      approvedByUserId: "operator",
    });
    expect(pushApproval.ok).toBe(true);
    expect(externalApproval.ok).toBe(true);
    if (!pushApproval.ok || !externalApproval.ok) throw new Error("expected approvals");

    harness.children[0]?.stdout.write(
      permissionLine({
        requestId: "perm-1992-push-merge",
        kind: "delivery-substrate",
        actionClass: "delivery-substrate",
        reasonCode: "approval-required",
        actionKind: "merge",
        scopeLabel: "workspace-scope",
        risk: "critical",
        policyReason: "approval-required",
        commandLabel: "merge",
        approvalToken: pushApproval.approval,
      }),
    );
    harness.children[0]?.stdout.write(
      permissionLine({
        requestId: "perm-1992-external-write-source-control",
        kind: "connector-access",
        actionClass: "connector-access",
        reasonCode: "approval-required",
        actionKind: "external-write",
        scopeLabel: "workspace-scope",
        risk: "high",
        policyReason: "approval-required",
        commandLabel: "external-write",
        connectorScopes: ["source-control.write"],
        approvalToken: externalApproval.approval,
      }),
    );
    await settle();

    const staleFailures = events.filter((event) => event.failureCode === "approval-proof-stale");
    expect(staleFailures).toHaveLength(2);
    expect(events.some((event) => event.kind === "artifact-produced")).toBe(false);
    expect(JSON.stringify(events)).not.toContain(pushApproval.approval.approvalToken);
    expect(JSON.stringify(events)).not.toContain(externalApproval.approval.approvalToken);
  });

  it("suppresses post-stop sidecar mutation events from manager-owned stop state", async () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const events: CodingWorkbenchRuntimeEvent[] = [];
    const timers: (() => void)[] = [];
    const manager = createCodingRuntimeManager({
      spawn: harness.spawn,
      processEnv: {},
      now: () => 1_000,
      killScheduler: {
        setTimer: (callback): unknown => {
          timers.push(callback);
          return undefined;
        },
      },
      onRuntimeEvent: (event) => {
        events.push(event);
      },
      nowIso: () => "2026-07-07T13:00:00.000Z",
    });

    manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    const issued = manager.issueApproval({
      runId: "run-1988",
      requestId: "perm-1992-push-stopped",
      actionKind: "push",
      approvedByUserId: "operator",
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error("expected approval issue to succeed");

    const stopping = manager.stop("run-1988");
    expect(
      manager.issueApproval({
        runId: "run-1988",
        requestId: "perm-1992-push-stopped",
        actionKind: "push",
        approvedByUserId: "operator",
      }),
    ).toEqual({ ok: false, failureCode: "runtime-stopped", retryable: false });
    harness.children[0]?.stdout.write(
      pushPermissionLine("perm-1992-push-stopped", issued.approval),
    );
    await settle();

    expect(events.some((event) => event.kind === "artifact-produced")).toBe(false);
    expect(events.some((event) => event.failureCode === "approval-proof-accepted")).toBe(false);
    timers[0]?.();
    await stopping;
    expect(harness.children[0]?.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("fails closed for mismatched supervised sidecar permission metadata", async () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const events: CodingWorkbenchRuntimeEvent[] = [];
    const manager = createCodingRuntimeManager({
      spawn: harness.spawn,
      processEnv: {},
      onRuntimeEvent: (event) => {
        events.push(event);
      },
      nowIso: () => "2026-07-07T13:00:00.000Z",
    });

    manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    harness.children[0]?.stdout.write(
      permissionLine({
        requestId: "perm-1992-push-workspace-write",
        kind: "workspace-write",
        actionClass: "workspace-write",
        reasonCode: "approval-required",
        actionKind: "push",
        scopeLabel: "workspace-scope",
        risk: "high",
        policyReason: "approval-required",
        scopeDigest: "a".repeat(64),
      }),
    );
    harness.children[0]?.stdout.write(
      permissionLine({
        requestId: "perm-1992-external-write-connector-read-scope",
        kind: "connector-access",
        actionClass: "connector-access",
        reasonCode: "approval-required",
        actionKind: "external-write",
        scopeLabel: "workspace-scope",
        risk: "high",
        policyReason: "approval-required",
        connectorScopes: ["issue-tracker.read"],
        scopeDigest: "a".repeat(64),
      }),
    );
    await settle();

    const failures = events.filter((event) => event.failureSummary === "sidecar-event-denied");
    expect(failures).toHaveLength(2);
    expect(events.some((event) => event.kind === "permission-requested")).toBe(false);
  });

  it.each([
    {
      kind: "workspace-write",
      actionClass: "workspace-write",
      reasonCode: "workspace-write-denied",
    },
    {
      kind: "command-execution",
      actionClass: "command-execution",
      reasonCode: "command-execution-denied",
      commandLabel: "npm",
    },
    {
      kind: "network-egress",
      actionClass: "network-egress",
      reasonCode: "network-denied",
    },
    {
      kind: "delivery-substrate",
      actionClass: "delivery-substrate",
      reasonCode: "delivery-denied",
    },
  ] as const)(
    "denies governed-assist $actionClass sidecar permission attempts before approval",
    async ({ kind, actionClass, reasonCode, commandLabel }) => {
      const fixture = createManagedFixture();
      const harness = createSpawnHarness();
      const events: CodingWorkbenchRuntimeEvent[] = [];
      const manager = createCodingRuntimeManager({
        spawn: harness.spawn,
        processEnv: {},
        onRuntimeEvent: (event) => {
          events.push(event);
        },
        nowIso: () => "2026-07-07T13:00:00.000Z",
      });

      manager.start(
        governedAssistRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
      );
      harness.children[0]?.stdout.write(
        permissionLine({
          requestId: "perm-1991-policy",
          kind,
          actionClass,
          reasonCode: "permission-requested",
          commandLabel,
        }),
      );
      await settle();

      const deniedEvent = events.find((event) => event.failureCode === reasonCode);
      expect(deniedEvent).toMatchObject({
        schemaVersion: "1",
        runId: "run-1991",
        kind: "failure-redacted",
        failureCode: reasonCode,
        failureSummary: reasonCode,
        retryable: false,
      });
      expect(events.some((event) => event.kind === "permission-requested")).toBe(false);
      expect(validateCodingWorkbenchRuntimeEvent(deniedEvent).ok).toBe(true);
      expect(JSON.stringify(deniedEvent)).not.toContain(fixture.workspaceRoot);
    },
  );

  it("keeps governed-assist connector reads approvable but denies write-capable or malformed scopes", async () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const events: CodingWorkbenchRuntimeEvent[] = [];
    const manager = createCodingRuntimeManager({
      spawn: harness.spawn,
      processEnv: {},
      onRuntimeEvent: (event) => {
        events.push(event);
      },
      nowIso: () => "2026-07-07T13:00:00.000Z",
    });

    manager.start(
      governedAssistRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    harness.children[0]?.stdout.write(
      permissionLine({
        requestId: "perm-1991-connector-read",
        kind: "connector-access",
        actionClass: "connector-access",
        reasonCode: "connector-access-requested",
        connectorScopes: ["issue-tracker.read"],
      }),
    );
    harness.children[0]?.stdout.write(
      permissionLine({
        requestId: "perm-1991-connector-write",
        kind: "connector-access",
        actionClass: "connector-access",
        reasonCode: "connector-access-requested",
        connectorScopes: ["source-control.write"],
      }),
    );
    harness.children[0]?.stdout.write(
      `${JSON.stringify({
        type: "permission-request",
        requestId: "perm-1991-connector-malformed",
        kind: "connector-access",
        actionClass: "connector-access",
        reasonCode: "connector-access-requested",
        expiresAt: "2026-07-07T13:05:00.000Z",
        connectorScopes: ["source-control.write", "unexpected.write"],
      })}\n`,
    );
    await settle();

    const permissionEvents = events.filter((event) => event.kind === "permission-requested");
    expect(permissionEvents).toHaveLength(1);
    expect(permissionEvents[0]).toMatchObject({
      permissionRequest: {
        requestId: "perm-1991-connector-read",
        connectorScopes: ["issue-tracker.read"],
      },
    });
    expect(events.find((event) => event.failureCode === "connector-write-denied")).toMatchObject({
      kind: "failure-redacted",
      failureSummary: "connector-write-denied",
      retryable: false,
    });
    expect(events.find((event) => event.failureSummary === "sidecar-event-denied")).toMatchObject({
      kind: "failure-redacted",
      failureCode: "failure-redacted",
      retryable: false,
    });
  });

  it("escalates stop to SIGKILL when the sidecar misses the shutdown deadline", async () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const setTimer = vi.fn((callback: () => void): unknown => {
      callback();
      return undefined;
    });
    const manager = createCodingRuntimeManager({
      spawn: harness.spawn,
      processEnv: {},
      killScheduler: { setTimer },
    });

    manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    await manager.stop("run-1988");

    expect(harness.children[0]?.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(manager.health()).toEqual({ status: "stopped" });
  });
});
