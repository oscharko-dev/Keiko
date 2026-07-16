import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkspaceMutexRegistry } from "../../task-workspace/mutex.js";
import { createDebugActivationControlService } from "./debugActivationControl.js";
import type { DebugActivationEvidence } from "./debugActivationEvidence.js";

const roots: string[] = [];

function temporaryDirectory(label: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), `keiko-${label}-`)));
  roots.push(path);
  return path;
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function context(
  realRoot: string,
  workspaceActivation: "enabled" | "disabled",
  revision = 7,
): Readonly<{
  readonly realRoot: string;
  readonly revision: number;
  readonly workspaceActivation: "enabled" | "disabled";
}> {
  return { realRoot, revision, workspaceActivation };
}

describe("debug activation control", () => {
  it.each([
    ["unsupported product", "unsupported", "allowed", "enabled", "PRODUCT_UNSUPPORTED"],
    ["denied deployment", "supported", "denied", "enabled", "POLICY_DENIED"],
    ["disabled workspace", "supported", "allowed", "disabled", "WORKSPACE_DISABLED"],
    ["unset workspace", "supported", "allowed", "unset", "WORKSPACE_ACTIVATION_UNSET"],
  ] as const)(
    "skips runtime-closure inspection for an already closed %s gate",
    (_name, productSupport, deploymentPolicy, workspaceActivation, reasonCode) => {
      const root = temporaryDirectory("debug-closed-gate");
      const provisioning = vi.fn(() => "provisioned" as const);
      const control = createDebugActivationControlService({
        mutex: createWorkspaceMutexRegistry(),
        productSupport: () => productSupport,
        deploymentPolicy: () => deploymentPolicy,
        provisioning,
        disposeActiveSession: () => Promise.resolve(),
      });

      expect(control.resolve({ realRoot: root, revision: 7, workspaceActivation })).toMatchObject({
        reasonCode,
      });
      expect(provisioning).not.toHaveBeenCalled();
      control.dispose();
    },
  );

  it("revalidates provisioning for every decision that can become available", () => {
    const root = temporaryDirectory("debug-open-gate");
    const provisioning = vi.fn(() => "provisioned" as const);
    const control = createDebugActivationControlService({
      mutex: createWorkspaceMutexRegistry(),
      productSupport: () => "supported",
      deploymentPolicy: () => "allowed",
      provisioning,
      disposeActiveSession: () => Promise.resolve(),
    });

    expect(control.resolve(context(root, "enabled"))).toMatchObject({ state: "available" });
    expect(control.resolve(context(root, "enabled"))).toMatchObject({ state: "available" });
    expect(provisioning).toHaveBeenCalledTimes(2);
    control.dispose();
  });

  it("awaits session disposal before acknowledging deactivation and projects content-free evidence", async () => {
    const root = temporaryDirectory("debug-control-workspace");
    let releaseDispose: (() => void) | undefined;
    const order: string[] = [];
    const evidence: DebugActivationEvidence[] = [];
    const control = createDebugActivationControlService({
      mutex: createWorkspaceMutexRegistry(),
      productSupport: () => "supported",
      deploymentPolicy: () => "allowed",
      provisioning: () => "provisioned",
      disposeActiveSession: () =>
        new Promise<void>((resolve) => {
          order.push("dispose-start");
          releaseDispose = (): void => {
            order.push("dispose-end");
            resolve();
          };
        }),
      projectEvidence: (_fingerprint, entry): void => {
        order.push("evidence");
        evidence.push(entry);
      },
      now: () => 1,
    });
    expect(control.resolve(context(root, "enabled"))).toMatchObject({ state: "available" });

    const pending = control.synchronize({
      action: "deactivate",
      changed: true,
      context: context(root, "disabled"),
    });
    await Promise.resolve();
    expect(order).toEqual(["dispose-start"]);
    expect(evidence).toEqual([]);

    releaseDispose?.();
    await expect(pending).resolves.toMatchObject({
      state: "disabled",
      reasonCode: "WORKSPACE_DISABLED",
    });
    expect(order).toEqual(["dispose-start", "dispose-end", "evidence"]);
    expect(evidence).toEqual([
      expect.objectContaining({ action: "deactivate", effectiveState: "disabled", revision: 7 }),
    ]);
    expect(JSON.stringify(evidence)).not.toContain(root);
    control.dispose();
  });

  it("revokes within the one-second watchdog when provisioning narrows asynchronously", async () => {
    vi.useFakeTimers();
    const root = temporaryDirectory("debug-watchdog-workspace");
    let provisioning: "provisioned" | "notProvisioned" = "provisioned";
    const disposeActiveSession = vi.fn(() => Promise.resolve());
    const evidence: DebugActivationEvidence[] = [];
    const control = createDebugActivationControlService({
      mutex: createWorkspaceMutexRegistry(),
      productSupport: () => "supported",
      deploymentPolicy: () => "allowed",
      provisioning: () => provisioning,
      disposeActiveSession,
      projectEvidence: (_fingerprint, entry): void => {
        evidence.push(entry);
      },
      watchdogIntervalMs: 1_000,
    });
    control.resolve(context(root, "enabled"));
    provisioning = "notProvisioned";

    await vi.advanceTimersByTimeAsync(1_000);

    expect(disposeActiveSession).toHaveBeenCalledExactlyOnceWith(root);
    expect(evidence.at(-1)).toMatchObject({
      action: "revoke",
      effectiveState: "notProvisioned",
    });
    control.dispose();
  });

  it("does not let an activation read swallow a pending available-to-denied revocation", async () => {
    vi.useFakeTimers();
    const root = temporaryDirectory("debug-read-before-watchdog");
    let provisioning: "provisioned" | "notProvisioned" = "provisioned";
    const disposeActiveSession = vi.fn(() => Promise.resolve());
    const control = createDebugActivationControlService({
      mutex: createWorkspaceMutexRegistry(),
      productSupport: () => "supported",
      deploymentPolicy: () => "allowed",
      provisioning: () => provisioning,
      disposeActiveSession,
      watchdogIntervalMs: 1_000,
    });
    expect(control.resolve(context(root, "enabled"))).toMatchObject({ state: "available" });
    provisioning = "notProvisioned";

    expect(control.resolve(context(root, "enabled"))).toMatchObject({ state: "notProvisioned" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(disposeActiveSession).toHaveBeenCalledExactlyOnceWith(root);
    control.dispose();
  });

  it("validates activation freshness against the exact workspace and revision", () => {
    const first = temporaryDirectory("debug-freshness-first");
    const second = temporaryDirectory("debug-freshness-second");
    const control = createDebugActivationControlService({
      mutex: createWorkspaceMutexRegistry(),
      productSupport: () => "supported",
      deploymentPolicy: () => "allowed",
      provisioning: () => "provisioned",
      disposeActiveSession: () => Promise.resolve(),
    });
    control.resolve(context(first, "enabled", 7));
    control.resolve(context(second, "enabled", 9));

    expect(control.isCurrent(first, 7)).toBe(true);
    expect(control.isCurrent(first, 9)).toBe(false);
    expect(control.isCurrent(second, 9)).toBe(true);
    expect(control.isCurrent(second, 7)).toBe(false);

    control.resolve(context(second, "enabled", 7));
    expect(control.isCurrent(first, 7)).toBe(true);
    expect(control.isCurrent(second, 7)).toBe(true);
    control.dispose();
  });

  it("catches redacted sweep failures per workspace and keeps sweeping healthy workspaces", async () => {
    vi.useFakeTimers();
    const failing = temporaryDirectory("debug-sweep-failing");
    const healthy = temporaryDirectory("debug-sweep-healthy");
    let provisioning: "provisioned" | "notProvisioned" = "provisioned";
    const failures: unknown[] = [];
    const disposals: string[] = [];
    const control = createDebugActivationControlService({
      mutex: createWorkspaceMutexRegistry(),
      productSupport: () => "supported",
      deploymentPolicy: () => "allowed",
      provisioning: () => provisioning,
      disposeActiveSession: (root) => {
        disposals.push(root);
        return root === failing
          ? Promise.reject(new Error(`sensitive:${root}`))
          : Promise.resolve();
      },
      onSweepFailure: (failure): void => {
        failures.push(failure);
      },
      watchdogIntervalMs: 1_000,
    });
    control.resolve(context(failing, "enabled"));
    control.resolve(context(healthy, "enabled"));
    provisioning = "notProvisioned";

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    expect(disposals).toEqual(expect.arrayContaining([failing, healthy]));
    expect(failures).toEqual([
      { schemaVersion: "1", code: "ACTIVATION_SWEEP_FAILED", source: "watchdog" },
    ]);
    expect(JSON.stringify(failures)).not.toContain(failing);
    expect(JSON.stringify(failures)).not.toContain("sensitive");

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();
    expect(disposals.filter((root) => root === failing)).toHaveLength(2);
    expect(disposals.filter((root) => root === healthy)).toHaveLength(1);
    control.dispose();
  });

  it("does not revoke a live session merely because the shared M7 settings revision counter bumped", async () => {
    vi.useFakeTimers();
    const root = temporaryDirectory("debug-unrelated-revision-bump");
    const disposeActiveSession = vi.fn(() => Promise.resolve());
    const control = createDebugActivationControlService({
      mutex: createWorkspaceMutexRegistry(),
      productSupport: () => "supported",
      deploymentPolicy: () => "allowed",
      provisioning: () => "provisioned",
      disposeActiveSession,
      watchdogIntervalMs: 1_000,
    });
    // The workspace stays enabled/available across both resolves; only the combined M7 revision
    // (bumped by an unrelated setting such as fontSize) changes, which must never look like
    // narrowing.
    expect(control.resolve(context(root, "enabled", 5))).toMatchObject({ state: "available" });
    expect(control.resolve(context(root, "enabled", 6))).toMatchObject({ state: "available" });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(disposeActiveSession).not.toHaveBeenCalled();
    control.dispose();
  });

  it("does not let a routine no-op watchdog tick overwrite real deactivation evidence", async () => {
    vi.useFakeTimers();
    const root = temporaryDirectory("debug-evidence-no-overwrite");
    const evidence: DebugActivationEvidence[] = [];
    const control = createDebugActivationControlService({
      mutex: createWorkspaceMutexRegistry(),
      productSupport: () => "supported",
      deploymentPolicy: () => "allowed",
      provisioning: () => "provisioned",
      disposeActiveSession: () => Promise.resolve(),
      projectEvidence: (_fingerprint, entry): void => {
        evidence.push(entry);
      },
      watchdogIntervalMs: 1_000,
    });

    await control.synchronize({
      action: "deactivate",
      changed: true,
      context: context(root, "disabled", 5),
    });
    expect(evidence).toEqual([
      expect.objectContaining({ action: "deactivate", outcome: "accepted", revision: 5 }),
    ]);

    // A full watchdog tick passes with nothing further changed -- the routine, non-revoking
    // settingsChange sweep must not durably re-record (and thereby overwrite) the real event.
    await vi.advanceTimersByTimeAsync(1_000);

    expect(evidence).toHaveLength(1);
    control.dispose();
  });

  it("evicts an idle-tracked workspace after the retention window instead of watching it forever", async () => {
    vi.useFakeTimers();
    const root = temporaryDirectory("debug-idle-eviction");
    let provisioningCalls = 0;
    const control = createDebugActivationControlService({
      mutex: createWorkspaceMutexRegistry(),
      productSupport: () => "supported",
      deploymentPolicy: () => "allowed",
      provisioning: (): "provisioned" => {
        provisioningCalls += 1;
        return "provisioned";
      },
      disposeActiveSession: () => Promise.resolve(),
      watchdogIntervalMs: 1_000,
      trackedIdleTtlMs: 5_000,
    });
    control.resolve(context(root, "enabled"));
    provisioningCalls = 0;

    await vi.advanceTimersByTimeAsync(4_000);
    expect(provisioningCalls).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(10_000);
    const callsAfterEviction = provisioningCalls;

    // No further resolve()/synchronize() ever touches this workspace again, so once it ages out
    // the watchdog must stop paying its per-second cost for it, forever.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(provisioningCalls).toBe(callsAfterEviction);
    control.dispose();
  });
});
