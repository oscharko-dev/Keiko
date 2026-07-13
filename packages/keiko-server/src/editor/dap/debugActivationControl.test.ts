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
): Readonly<{
  readonly realRoot: string;
  readonly revision: 7;
  readonly workspaceActivation: "enabled" | "disabled";
}> {
  return { realRoot, revision: 7, workspaceActivation } as const;
}

describe("debug activation control", () => {
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
});
