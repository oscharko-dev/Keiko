import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  UpdateInstallMode,
  UpdatePreflightReport,
  UpdateRuntimeState,
} from "@oscharko-dev/keiko-contracts";
import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";
import { createUpdateCandidateAuthority } from "./update-candidate-authority.js";
import { createUpdateLocalStateManager } from "./update-local-state.js";
import { createUpdateSessionManager } from "./update-session.js";
import type { UpdateSessionLock } from "./update-session-lock.js";

const NOW = Date.parse("2026-09-04T12:00:00.000Z");
const roots: string[] = [];

function mode(): UpdateInstallMode {
  return {
    schemaVersion: "1",
    status: "supported",
    packageName: "@oscharko-dev/keiko",
    installKind: "package-manager",
    packageManager: "npm",
    installRoot: "/opt/keiko",
  };
}

function report(): UpdatePreflightReport {
  return {
    schemaVersion: 1,
    checkedAt: "2026-09-04T12:00:00.000Z",
    currentVersion: "0.3.17",
    targetVersion: "0.3.18",
    updateAvailable: true,
    status: "update-available",
    availabilityState: "update-available",
    severity: "normal",
    registryStatus: "ok",
    releaseMetadataStatus: "live",
    installabilitySource: "npm-registry",
    userActionRequired: false,
    affectedStateStores: [],
    blockers: [],
    manualUpdateRequired: false,
    oneClickEligible: true,
    release: {
      source: "github-release",
      tag: "v0.3.18",
      title: "Keiko 0.3.18",
      summary: "Reviewed update",
      notes: [],
    },
    impact: {
      entries: [],
      releaseNoteBullets: [],
      stateImpact: [],
      affectedStateStores: [],
      userActionRequired: false,
      remediations: [],
    },
    warnings: [],
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable update session lifecycle", () => {
  it("settles a rejected beforeExecute hook, releases the lock, and persists failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-update-session-durable-"));
    roots.push(root);
    const delegate = createUpdateLocalStateManager({ stateDir: root, now: () => NOW });
    const terminalWrites: string[] = [];
    const localState = {
      ...delegate,
      writeRuntimeState: (state: UpdateRuntimeState): UpdateRuntimeState => {
        if (state.lastSession?.phase === "failed" || state.activeSession?.phase === "failed") {
          terminalWrites.push(
            state.activeSession === undefined ? "settled-failed" : "active-failed",
          );
        }
        return delegate.writeRuntimeState(state);
      },
    };
    const authority = createUpdateCandidateAuthority({ now: () => NOW });
    let lockHeld = false;
    const lock: UpdateSessionLock = {
      isLocked: () => lockHeld,
      acquire: () => {
        lockHeld = true;
        return true;
      },
      updateChildPid: () => true,
      release: () => {
        const durable = delegate.readRuntimeState();
        expect(durable.activeSession).toBeUndefined();
        expect(durable.lastSession).toMatchObject({ phase: "failed" });
        lockHeld = false;
      },
    };
    const reviewed = report();
    const claim = authority.issue(reviewed, mode());
    expect(claim).toBeDefined();
    const manager = createUpdateSessionManager({
      detector: mode,
      currentVersion: () => "0.3.17",
      now: () => NOW,
      candidateAuthority: authority,
      localState,
      lock,
      beforeExecute: () => Promise.reject(new Error("hook rejected")),
    });

    manager.start(
      {
        candidateId: claim?.candidateId ?? "missing",
        confirmationDigest: claim?.confirmationDigest ?? "0".repeat(64),
        executionToken: claim?.executionToken ?? "0".repeat(64),
      },
      reviewed,
    );

    await vi.waitFor(() => {
      expect(manager.getStatus().lastSession?.phase).toBe("failed");
    });
    expect(lockHeld).toBe(false);
    const durable = localState.readRuntimeState();
    expect(durable).not.toHaveProperty("activeSession");
    expect(durable).toMatchObject({
      lastSession: { phase: "failed", lifecycle: { phase: "failed" } },
    });
    expect(terminalWrites).toEqual(["settled-failed"]);
  });

  it("retains the lock when terminal aggregate persistence fails and restarts from pre-terminal state", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-update-session-terminal-failure-"));
    roots.push(root);
    const delegate = createUpdateLocalStateManager({ stateDir: root, now: () => NOW });
    const authority = createUpdateCandidateAuthority({ now: () => NOW });
    const events: SecurityLogEvent[] = [];
    let lockHeld = false;
    const lock: UpdateSessionLock = {
      isLocked: () => lockHeld,
      acquire: () => {
        lockHeld = true;
        return true;
      },
      updateChildPid: () => true,
      release: () => {
        lockHeld = false;
      },
    };
    const localState = {
      ...delegate,
      writeRuntimeState: (state: UpdateRuntimeState): UpdateRuntimeState => {
        if (state.activeSession === undefined && state.lastSession?.phase === "failed") {
          throw new Error("terminal aggregate unavailable");
        }
        return delegate.writeRuntimeState(state);
      },
    };
    const reviewed = report();
    const claim = authority.issue(reviewed, mode());
    const manager = createUpdateSessionManager({
      detector: mode,
      currentVersion: () => "0.3.17",
      now: () => NOW,
      candidateAuthority: authority,
      localState,
      lock,
      activityLog: { write: (event): void => void events.push(event) },
      beforeExecute: () => Promise.reject(new Error("hook rejected")),
    });

    manager.start(
      {
        candidateId: claim?.candidateId ?? "missing",
        confirmationDigest: claim?.confirmationDigest ?? "0".repeat(64),
        executionToken: claim?.executionToken ?? "0".repeat(64),
      },
      reviewed,
    );

    await vi.waitFor(() => {
      expect(manager.getStatus().persistence).toBe("unwritable");
    });
    expect(lockHeld).toBe(true);
    expect(delegate.readRuntimeState().activeSession).toMatchObject({
      phase: "preparing",
      lifecycle: { phase: "preparing" },
    });
    const persistenceFailures = events.filter(
      (event) =>
        event.op === "update.session.lifecycle" && event.extra?.eventKind === "persistence-failed",
    );
    expect(persistenceFailures).toHaveLength(1);
    expect(persistenceFailures[0]?.extra).toMatchObject({
      phase: "preparing",
      eventKind: "persistence-failed",
    });

    const restarted = createUpdateSessionManager({
      detector: mode,
      currentVersion: () => "0.3.17",
      now: () => NOW,
      localState: delegate,
    });
    expect(restarted.getStatus().activeSession).toBeUndefined();
    expect(restarted.getStatus()).toMatchObject({
      persistence: "ready",
      lastSession: { phase: "failed", lifecycle: { phase: "failed" } },
    });
  });

  it("reports synchronous cancellation persistence failure and retains authoritative ownership", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-update-session-cancel-failure-"));
    roots.push(root);
    const delegate = createUpdateLocalStateManager({ stateDir: root, now: () => NOW });
    const authority = createUpdateCandidateAuthority({ now: () => NOW });
    const events: SecurityLogEvent[] = [];
    let lockHeld = false;
    const release = vi.fn(() => {
      lockHeld = false;
    });
    const lock: UpdateSessionLock = {
      isLocked: () => lockHeld,
      acquire: () => {
        lockHeld = true;
        return true;
      },
      updateChildPid: () => true,
      release,
    };
    const localState = {
      ...delegate,
      writeRuntimeState: (state: UpdateRuntimeState): UpdateRuntimeState => {
        if (state.activeSession === undefined && state.lastSession?.phase === "cancelled") {
          throw new Error("cancel settlement unavailable");
        }
        return delegate.writeRuntimeState(state);
      },
    };
    const reviewed = report();
    const claim = authority.issue(reviewed, mode());
    const manager = createUpdateSessionManager({
      detector: mode,
      currentVersion: () => "0.3.17",
      now: () => NOW,
      candidateAuthority: authority,
      localState,
      lock,
      activityLog: { write: (event): void => void events.push(event) },
      beforeExecute: () => new Promise<void>(() => undefined),
    });
    const started = manager.start(
      {
        candidateId: claim?.candidateId ?? "missing",
        confirmationDigest: claim?.confirmationDigest ?? "0".repeat(64),
        executionToken: claim?.executionToken ?? "0".repeat(64),
      },
      reviewed,
    ).session;

    expect(() => manager.cancel()).toThrow("cancel settlement unavailable");

    expect(manager.getStatus()).toMatchObject({
      persistence: "unwritable",
      activeSession: {
        sessionId: started.sessionId,
        phase: "preparing",
        lifecycle: { phase: "preparing", cancellationCutoff: "not-reached" },
      },
    });
    expect(delegate.readRuntimeState().activeSession).toMatchObject({
      sessionId: started.sessionId,
      phase: "preparing",
    });
    expect(lockHeld).toBe(true);
    expect(release).not.toHaveBeenCalled();
    const persistenceFailures = events.filter(
      (event) =>
        event.op === "update.session.lifecycle" && event.extra?.eventKind === "persistence-failed",
    );
    expect(persistenceFailures).toHaveLength(1);
    expect(persistenceFailures[0]).toMatchObject({
      category: "diagnostic",
      correlationId: started.correlationId,
      extra: {
        sessionId: started.sessionId,
        phase: "preparing",
        cancellationCutoff: "not-reached",
        eventKind: "persistence-failed",
      },
    });
    expect(persistenceFailures[0]?.extra).not.toHaveProperty("installRoot");
    expect(persistenceFailures[0]?.extra).not.toHaveProperty("logs");
  });

  it("rehydrates interrupted pre-mutation state as a failure without success fabrication", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-update-session-rehydrate-"));
    roots.push(root);
    const localState = createUpdateLocalStateManager({ stateDir: root, now: () => NOW });
    const authority = createUpdateCandidateAuthority({ now: () => NOW });
    const reviewed = report();
    const claim = authority.issue(reviewed, mode());
    const first = createUpdateSessionManager({
      detector: mode,
      currentVersion: () => "0.3.17",
      now: () => NOW,
      candidateAuthority: authority,
      localState,
      beforeExecute: () => new Promise<void>(() => undefined),
    });
    first.start(
      {
        candidateId: claim?.candidateId ?? "missing",
        confirmationDigest: claim?.confirmationDigest ?? "0".repeat(64),
        executionToken: claim?.executionToken ?? "0".repeat(64),
      },
      reviewed,
    );

    const restarted = createUpdateSessionManager({
      detector: mode,
      currentVersion: () => "0.3.17",
      now: () => NOW,
      candidateAuthority: createUpdateCandidateAuthority({ now: () => NOW }),
      localState,
    });

    const status = restarted.getStatus();
    expect(status).not.toHaveProperty("activeSession");
    expect(status).toMatchObject({
      lastSession: { phase: "failed", lifecycle: { phase: "failed" } },
      persistence: "ready",
    });
  });

  it("settles a legacy terminal-active record without converting success into recovery", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-update-session-terminal-restore-"));
    roots.push(root);
    const localState = createUpdateLocalStateManager({ stateDir: root, now: () => NOW });
    const authority = createUpdateCandidateAuthority({ now: () => NOW });
    const reviewed = report();
    const claim = authority.issue(reviewed, mode());
    const first = createUpdateSessionManager({
      detector: mode,
      currentVersion: () => "0.3.17",
      now: () => NOW,
      candidateAuthority: authority,
      localState,
      beforeExecute: () => new Promise<void>(() => undefined),
    });
    first.start(
      {
        candidateId: claim?.candidateId ?? "missing",
        confirmationDigest: claim?.confirmationDigest ?? "0".repeat(64),
        executionToken: claim?.executionToken ?? "0".repeat(64),
      },
      reviewed,
    );
    const current = localState.readRuntimeState();
    const active = current.activeSession;
    if (active === undefined) throw new TypeError("expected active session");
    localState.writeRuntimeState({
      ...current,
      activeSession: {
        ...active,
        phase: "succeeded",
        lifecycle: {
          ...active.lifecycle,
          phase: "succeeded",
          cancellationCutoff: "handoff-committed",
        },
        cancelable: false,
        restartRequired: false,
        message: "Update completed before ownership settlement.",
      },
      recovery: {
        status: "reconciling",
        sessionId: active.sessionId,
        updatedAt: new Date(NOW).toISOString(),
      },
    });
    let lockHeld = true;
    const lock: UpdateSessionLock = {
      isLocked: () => lockHeld,
      acquire: () => false,
      updateChildPid: () => false,
      release: () => {
        lockHeld = false;
      },
    };

    const restarted = createUpdateSessionManager({
      detector: mode,
      currentVersion: () => "0.3.18",
      now: () => NOW,
      localState,
      lock,
    });

    expect(restarted.getStatus().activeSession).toBeUndefined();
    expect(restarted.getStatus()).toMatchObject({
      persistence: "ready",
      lastSession: { phase: "succeeded", lifecycle: { phase: "succeeded" } },
    });
    const durable = localState.readRuntimeState();
    expect(durable.activeSession).toBeUndefined();
    expect(durable).toMatchObject({
      lastSession: { phase: "succeeded", lifecycle: { phase: "succeeded" } },
      recovery: { status: "none" },
    });
    expect(lockHeld).toBe(false);
  });

  it("rehydrates a committed handoff as recovery-required and retains its ownership", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-update-session-handoff-rehydrate-"));
    roots.push(root);
    const localState = createUpdateLocalStateManager({ stateDir: root, now: () => NOW });
    const authority = createUpdateCandidateAuthority({ now: () => NOW });
    const reviewed = report();
    const claim = authority.issue(reviewed, mode());
    const first = createUpdateSessionManager({
      detector: mode,
      currentVersion: () => "0.3.17",
      now: () => NOW,
      candidateAuthority: authority,
      localState,
      runCommandImpl: () =>
        Promise.resolve({
          command: "npm",
          args: [],
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          durationMs: 1,
          timedOut: false,
          truncated: false,
        }),
    });
    first.start(
      {
        candidateId: claim?.candidateId ?? "missing",
        confirmationDigest: claim?.confirmationDigest ?? "0".repeat(64),
        executionToken: claim?.executionToken ?? "0".repeat(64),
      },
      reviewed,
    );
    await vi.waitFor(() => {
      expect(first.getStatus().activeSession?.lifecycle.phase).toBe("handoff-pending");
    });
    expect(localState.readRuntimeState().recovery.status).toBe("reconciling");

    const restarted = createUpdateSessionManager({
      detector: mode,
      currentVersion: () => "0.3.17",
      now: () => NOW,
      candidateAuthority: createUpdateCandidateAuthority({ now: () => NOW }),
      localState,
    });

    expect(restarted.getStatus()).toMatchObject({
      persistence: "ready",
      activeSession: {
        phase: "restart-required",
        lifecycle: {
          phase: "recovery-required",
          cancellationCutoff: "handoff-committed",
        },
      },
    });
    expect(localState.readRuntimeState().recovery).toMatchObject({
      status: "required",
      reason: "interrupted",
    });
  });
});
