// Issue #2211 — VerificationRunnerManager unit tests. The execution port is injected (a canned
// report/probe), so the manager exercises the real discovery + trust gate + plan composition +
// content-free lifecycle streaming without a real spawn. Route-level coverage lives in
// verificationRoutes.test.ts.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EditorVerificationEvent,
  VerificationKind,
  VerificationReport,
  VerificationResult,
  VerificationStatus,
} from "@oscharko-dev/keiko-contracts";
import { createInMemoryEvidenceStore, type EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import type { ExecuteVerificationResult } from "./verificationExecution.js";
import type { VerificationStepOutput } from "@oscharko-dev/keiko-verification";
import {
  createVerificationRunnerManager,
  decideScriptTrust,
  type VerificationExecutePort,
  type VerificationRunInput,
  type VerificationRunnerManager,
  type VerificationRunnerManagerOptions,
  type VerificationRunnerWorkspaceTrustDecider,
} from "./verificationRunner.js";
import { VerificationRunnerError } from "./verificationRunnerErrors.js";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import type { WorkspaceRootAccess } from "../task-workspace/workspace-root-access.js";
import type { ServerLogEvent } from "../observability/index.js";

const PACKAGE_JSON = JSON.stringify({
  name: "fixture",
  scripts: { typecheck: "tsc --noEmit", lint: "eslint .", test: "vitest run" },
  devDependencies: { vitest: "^1.0.0" },
});

function counts(
  over: Partial<Record<VerificationStatus, number>>,
): Record<VerificationStatus, number> {
  return {
    passed: 0,
    failed: 0,
    skipped: 0,
    denied: 0,
    "timed-out": 0,
    cancelled: 0,
    "resource-exceeded": 0,
    ...over,
  };
}

function report(kinds: readonly VerificationKind[]): VerificationReport {
  const results = kinds.map((kind): VerificationResult => ({
    kind,
    scriptName: undefined,
    command: "npm",
    args: [],
    status: "failed",
    exitCode: 1,
    signal: null,
    durationMs: 5,
    truncated: false,
    redacted: true,
    // Deliberately secret-looking: it must NEVER appear on a non-terminal SSE event (AC7).
    outputSummary: "SENSITIVE-LOOKING command output that must not reach a lifecycle event",
    appliedLimits: [],
  }));
  return {
    workspaceRoot: "/ws",
    results,
    overallStatus: "failed",
    startedAtMs: 1,
    durationMs: 5,
    counts: counts({ failed: kinds.length }),
  };
}

interface FakePort {
  readonly port: VerificationExecutePort;
  readonly correlationIds: (string | undefined)[];
  readonly fileSystems: (WorkspaceFs | undefined)[];
  calls: number;
}

function fakePort(rep: VerificationReport, waitForAbort = false): FakePort {
  const state: FakePort = {
    calls: 0,
    correlationIds: [],
    fileSystems: [],
    port: async (args): Promise<ExecuteVerificationResult> => {
      state.calls += 1;
      state.correlationIds.push(args.correlationId);
      state.fileSystems.push(args.fs);
      if (waitForAbort && !args.signal.aborted) {
        await new Promise<void>((resolve) => {
          args.signal.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
        });
      }
      return { report: rep, probe: { available: true, backend: "test-backend" } };
    },
  };
  return state;
}

// Subscribes and resolves `done` when a terminal event (completed/cancelled/failed) arrives.
function collect(manager: ReturnType<typeof createVerificationRunnerManager>): {
  events: EditorVerificationEvent[];
  done: Promise<void>;
} {
  const events: EditorVerificationEvent[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  manager.subscribe((event) => {
    events.push(event);
    if (
      event.kind === "run-completed" ||
      event.kind === "run-cancelled" ||
      event.kind === "run-failed"
    ) {
      resolveDone();
    }
  });
  return { events, done };
}

let workspaceRoot: string;
let store: UiStore;
let evidenceStore: EvidenceStore;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "keiko-verify-"));
  writeFileSync(join(workspaceRoot, "package.json"), PACKAGE_JSON, "utf8");
  mkdirSync(join(workspaceRoot, "src"), { recursive: true });
  writeFileSync(join(workspaceRoot, "src", "a.test.ts"), "test('x', () => {});\n", "utf8");
  store = createInMemoryUiStore();
  store.createProject(workspaceRoot, "fixture");
  evidenceStore = createInMemoryEvidenceStore();
});

afterEach(() => {
  store.close();
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function input(over: Partial<VerificationRunInput> = {}): VerificationRunInput {
  return { projectId: workspaceRoot, kinds: ["typecheck"], ...over };
}

// Defaults to a real in-memory evidenceStore (production always configures one); tests that care
// about the no-store or write-failure paths override it explicitly.
function makeManager(
  overrides: Partial<VerificationRunnerManagerOptions> = {},
): VerificationRunnerManager {
  return createVerificationRunnerManager({ store, evidenceStore, ...overrides });
}

describe("VerificationRunnerManager — workspace-trust gate (AC3/AC4)", () => {
  it("uses managed-root access for planning and execution and fails closed when denied", async () => {
    // `repositoryRoot` is production-shaped: `canonicalManagedRootAccess` sets it on EVERY granted
    // managed access, and since #3382 `WorkspaceRootAccess`'s `managed-task` member REQUIRES it, so
    // the fixture has to carry the field this root's own grant is resolved through.
    const access: WorkspaceRootAccess = {
      kind: "managed-task",
      canonicalRoot: workspaceRoot,
      fs: nodeWorkspaceFs,
      repositoryRoot: workspaceRoot,
    };
    const port = fakePort(report(["typecheck"]));
    const manager = makeManager({
      resolveWorkspaceRootAccess: () => access,
      execute: port.port,
      isWorkspaceTrustedForPackageScripts: () => true,
    });
    expect(manager.discover(workspaceRoot).kinds).not.toHaveLength(0);
    const { done } = collect(manager);
    manager.execute(input());
    await done;
    expect(port.fileSystems).toEqual([nodeWorkspaceFs]);
    expect(() =>
      makeManager({ resolveWorkspaceRootAccess: () => undefined }).discover(workspaceRoot),
    ).toThrow(expect.objectContaining({ code: "PROJECT_NOT_FOUND" }));
  });

  // Re-targeted for #3382/L-6. CodeRabbit, PR #3381 had pinned the `repositoryRoot === undefined`
  // branch — a managed worktree naming no repository used to fall through to the ORDINARY trust
  // path (`trustProjectId: projectId`, `trustBasisMatches: true`), taking its package-script
  // decision from its own unregistered root with the ADR-0147 D3 basis-equality guard skipped.
  // `WorkspaceRootAccess`'s `managed-task` member now REQUIRES `repositoryRoot`, so that shape is
  // unconstructable and the branch is gone. What the pin uniquely covered and no sibling test does
  // is the OTHER half: when the basis guard refuses script kinds, `targeted-test` — a
  // Keiko-synthesized invocation exempt from script trust — must still run, through the access
  // port. The refusal is now driven by the reachable cause (a worktree manifest that is not the
  // repository's byte-identical fact) instead of the removed one.
  it("refuses script kinds on a broken worktree trust basis, and still runs targeted-test", async () => {
    const worktreeRoot = mkdtempSync(join(tmpdir(), "keiko-verify-basis-targeted-"));
    try {
      writeFileSync(
        join(worktreeRoot, "package.json"),
        PACKAGE_JSON.replace('"typecheck"', '"typecheck-renamed"'),
        "utf8",
      );
      mkdirSync(join(worktreeRoot, "src"), { recursive: true });
      writeFileSync(join(worktreeRoot, "src", "a.test.ts"), "test('x', () => {});\n", "utf8");
      const access: WorkspaceRootAccess = {
        kind: "managed-task",
        canonicalRoot: worktreeRoot,
        fs: nodeWorkspaceFs,
        repositoryRoot: workspaceRoot,
      };
      const port = fakePort(report(["targeted-test"]));
      const manager = makeManager({
        resolveWorkspaceRootAccess: () => access,
        execute: port.port,
        isWorkspaceTrustedForPackageScripts: () => true,
      });

      expect(
        manager.discover(worktreeRoot).kinds.find((entry) => entry.kind === "typecheck")
          ?.trustState,
      ).toBe("approval-required");
      expect(() =>
        manager.execute(input({ projectId: worktreeRoot, kinds: ["typecheck"] })),
      ).toThrow(expect.objectContaining({ code: "WORKSPACE_TRUST_REQUIRED" }));
      const { done } = collect(manager);
      manager.execute(
        input({ projectId: worktreeRoot, kinds: ["targeted-test"], targetPath: "src/a.test.ts" }),
      );
      await done;
      expect(port.fileSystems).toEqual([nodeWorkspaceFs]);
    } finally {
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  // A managed task worktree carries no script-trust grant of its own (production DOES register it
  // as a project row — deps.ts `ensureManagedTaskWorkspaceIdentity` — but a row is not a trust
  // decision); the root access resolver proves the root and names the repository whose grant
  // governs it. This exercises the no-row shape, where `managedAccessFor` answers instead of
  // `accessFor`; either way the decision comes from the repository, never the worktree's own root,
  // which is what refused every governed verification inside a task workspace before this
  // (workbench end-to-end run, 2026-09-03).
  it("resolves a managed task worktree without a project row and takes script trust from its repository", async () => {
    const worktreeRoot = mkdtempSync(join(tmpdir(), "keiko-verify-worktree-"));
    // A REAL, resolvable directory the production resolver would grant ORDINARY access to. The
    // fake mirrors that grant instead of answering `undefined`, so the `managed-task` kind filter
    // in `managedAccessFor` is the ONLY thing that still produces PROJECT_NOT_FOUND below. With a
    // fake that refuses the root outright the assertion passed with the filter deleted
    // (`return access;`) and pinned nothing (PR #3381 review) — and the filter is what keeps the
    // production resolver's ordinary grant for ANY existing allowed directory out of the
    // unregistered path, where `targeted-test` is not trust-gated.
    const elsewhereRoot = mkdtempSync(join(tmpdir(), "keiko-verify-elsewhere-"));
    writeFileSync(join(elsewhereRoot, "package.json"), PACKAGE_JSON, "utf8");
    try {
      writeFileSync(join(worktreeRoot, "package.json"), PACKAGE_JSON, "utf8");
      mkdirSync(join(worktreeRoot, "src"), { recursive: true });
      writeFileSync(join(worktreeRoot, "src", "a.test.ts"), "test('x', () => {});\n", "utf8");
      const port = fakePort(report(["typecheck"]));
      const trustChecks: string[] = [];
      const manager = makeManager({
        resolveWorkspaceRootAccess: (root): WorkspaceRootAccess | undefined =>
          root === worktreeRoot
            ? {
                kind: "managed-task",
                canonicalRoot: worktreeRoot,
                fs: nodeWorkspaceFs,
                repositoryRoot: workspaceRoot,
              }
            : { kind: "ordinary", canonicalRoot: root, fs: nodeWorkspaceFs },
        execute: port.port,
        isWorkspaceTrustedForPackageScripts: (projectId, workspace): boolean => {
          trustChecks.push(`${projectId}|${workspace.root}`);
          return projectId === workspaceRoot;
        },
      });

      const catalog = manager.discover(worktreeRoot);
      expect(catalog.kinds.find((entry) => entry.kind === "typecheck")?.trustState).toBe("trusted");
      const { done } = collect(manager);
      manager.execute(input({ projectId: worktreeRoot }));
      await done;
      expect(port.calls).toBe(1);
      // The decider sees the repository's own (canonical) workspace, never the worktree's.
      expect(new Set(trustChecks)).toEqual(
        new Set([`${workspaceRoot}|${realpathSync(workspaceRoot)}`]),
      );
      // An unregistered ORDINARY root is still no project — even though the resolver grants it.
      expect(() => manager.discover(elsewhereRoot)).toThrow(
        expect.objectContaining({ code: "PROJECT_NOT_FOUND" }),
      );
      expect(() =>
        manager.execute(input({ projectId: elsewhereRoot, kinds: ["targeted-test"] })),
      ).toThrow(expect.objectContaining({ code: "PROJECT_NOT_FOUND" }));
    } finally {
      rmSync(elsewhereRoot, { recursive: true, force: true });
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  // The resolver's OWN refusal line (`workspace.root.denied`, emitted inside the production
  // resolver) landed under UNKNOWN_CORRELATION_ID because the runner called it with one argument,
  // so a denial that blocked a verification could not be joined to the run that asked for it
  // (PR #3381 review). Both run entry points hand the resolver the run's correlation; `discover`
  // has no run and passes none, which the third row pins so the parameter stays optional.
  it("hands the run's correlation id to the workspace root access resolver", async () => {
    const seen: (string | undefined)[] = [];
    const port = fakePort(report(["typecheck"]));
    const manager = makeManager({
      resolveWorkspaceRootAccess: (root, correlationId): WorkspaceRootAccess => {
        seen.push(correlationId);
        return { kind: "ordinary", canonicalRoot: root, fs: nodeWorkspaceFs };
      },
      execute: port.port,
      isWorkspaceTrustedForPackageScripts: () => true,
    });

    const { done } = collect(manager);
    manager.execute(input({ correlationId: "run-correlation-a" }));
    await done;
    await manager.runToReport(
      input({ correlationId: "run-correlation-b" }),
      new AbortController().signal,
    );
    manager.discover(workspaceRoot);

    expect(seen).toEqual(["run-correlation-a", "run-correlation-b", undefined]);
  });

  // ADR-0147 D3 binds the grant to exact `package.json` bytes. A governed run can rewrite its own
  // worktree manifest, so inheriting the repository's grant may only hold while the worktree is
  // that same fact — otherwise the rewritten script would run under a decision no human made for
  // it (P1, PR #3381 review).
  it("refuses a managed worktree whose package.json differs from its repository's", async () => {
    const worktreeRoot = mkdtempSync(join(tmpdir(), "keiko-verify-basis-"));
    try {
      writeFileSync(
        join(worktreeRoot, "package.json"),
        PACKAGE_JSON.replace('"typecheck"', '"typecheck-renamed"'),
        "utf8",
      );
      mkdirSync(join(worktreeRoot, "src"), { recursive: true });
      writeFileSync(join(worktreeRoot, "src", "a.test.ts"), "test('x', () => {});\n", "utf8");
      const port = fakePort(report(["typecheck"]));
      const manager = makeManager({
        resolveWorkspaceRootAccess: (root): WorkspaceRootAccess | undefined =>
          root === worktreeRoot
            ? {
                kind: "managed-task",
                canonicalRoot: worktreeRoot,
                fs: nodeWorkspaceFs,
                repositoryRoot: workspaceRoot,
              }
            : undefined,
        execute: port.port,
        isWorkspaceTrustedForPackageScripts: (): boolean => true,
      });

      expect(() =>
        manager.execute(input({ projectId: worktreeRoot, kinds: ["typecheck"] })),
      ).toThrow(
        expect.objectContaining({
          code: "WORKSPACE_TRUST_REQUIRED",
          trustRefusal: "worktree-manifest-drift",
        }),
      );
      expect(port.calls).toBe(0);
      // The same worktree with a byte-identical manifest keeps the repository's grant.
      writeFileSync(join(worktreeRoot, "package.json"), PACKAGE_JSON, "utf8");
      const { done } = collect(manager);
      manager.execute(input({ projectId: worktreeRoot, kinds: ["typecheck"] }));
      await done;
      expect(port.calls).toBe(1);
    } finally {
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  // ADR-0147 D3 (Coding Workbench run 8, 2026-09-10): a governed run that rewrote its worktree
  // manifest can only continue under an explicit human grant recorded for the worktree root itself.
  // The refusal names WHY on the run's own activity line — before this it read exactly like a
  // repository nobody had trusted, and the operator was pointed at a grant that cannot clear drift.
  it("admits a drifted worktree only under the worktree root's own explicit grant and logs the refusal reason", async () => {
    const worktreeRoot = mkdtempSync(join(tmpdir(), "keiko-verify-worktree-grant-"));
    try {
      writeFileSync(
        join(worktreeRoot, "package.json"),
        PACKAGE_JSON.replace('"tsc --noEmit"', '"tsc --noEmit && vite build"'),
        "utf8",
      );
      mkdirSync(join(worktreeRoot, "src"), { recursive: true });
      writeFileSync(join(worktreeRoot, "src", "a.test.ts"), "test('x', () => {});\n", "utf8");
      const port = fakePort(report(["typecheck"]));
      const events: ServerLogEvent[] = [];
      const humanGrantAsked: string[] = [];
      let worktreeGranted = false;
      const manager = makeManager({
        activityLog: { write: (event): void => void events.push(event) },
        resolveWorkspaceRootAccess: (root): WorkspaceRootAccess | undefined =>
          root === worktreeRoot
            ? {
                kind: "managed-task",
                canonicalRoot: worktreeRoot,
                fs: nodeWorkspaceFs,
                repositoryRoot: workspaceRoot,
              }
            : undefined,
        execute: port.port,
        isWorkspaceTrustedForPackageScripts: (): boolean => true,
        isWorktreeTrustedByHumanGrant: (canonicalRoot): boolean => {
          humanGrantAsked.push(canonicalRoot);
          return worktreeGranted;
        },
      });
      const typecheckTrust = (): string | undefined =>
        manager.discover(worktreeRoot).kinds.find((entry) => entry.kind === "typecheck")
          ?.trustState;

      expect(() =>
        manager.execute(
          input({ projectId: worktreeRoot, kinds: ["typecheck"], correlationId: "run-drift" }),
        ),
      ).toThrow(
        expect.objectContaining({
          code: "WORKSPACE_TRUST_REQUIRED",
          trustRefusal: "worktree-manifest-drift",
        }),
      );
      expect(humanGrantAsked).toEqual([worktreeRoot]);
      expect(events).toContainEqual(
        expect.objectContaining({
          op: "editor.verification.execute",
          correlationId: "run-drift",
          errorKind: "WORKSPACE_TRUST_REQUIRED",
          extra: expect.objectContaining({
            state: "refused",
            reason: "WORKSPACE_TRUST_REQUIRED",
            trustRefusal: "worktree-manifest-drift",
          }) as unknown,
        }),
      );
      expect(typecheckTrust()).toBe("approval-required");

      worktreeGranted = true;
      expect(typecheckTrust()).toBe("trusted");
      const { done } = collect(manager);
      manager.execute(input({ projectId: worktreeRoot, kinds: ["typecheck"] }));
      await done;
      expect(port.calls).toBe(1);
    } finally {
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  // The worktree's own record is consulted only once the repository's grant has stopped covering
  // it: a byte-identical worktree under a trusted repository never touches it (no invalidation
  // side effect on a derived record), and an untrusted repository names ITSELF as the reason.
  it("names an untrusted repository and asks the worktree grant only when the repository does not cover it", async () => {
    const worktreeRoot = mkdtempSync(join(tmpdir(), "keiko-verify-worktree-covered-"));
    try {
      writeFileSync(join(worktreeRoot, "package.json"), PACKAGE_JSON, "utf8");
      mkdirSync(join(worktreeRoot, "src"), { recursive: true });
      writeFileSync(join(worktreeRoot, "src", "a.test.ts"), "test('x', () => {});\n", "utf8");
      const port = fakePort(report(["typecheck"]));
      const humanGrant = vi.fn((): boolean => false);
      let repositoryTrusted = true;
      const manager = makeManager({
        resolveWorkspaceRootAccess: (root): WorkspaceRootAccess | undefined =>
          root === worktreeRoot
            ? {
                kind: "managed-task",
                canonicalRoot: worktreeRoot,
                fs: nodeWorkspaceFs,
                repositoryRoot: workspaceRoot,
              }
            : undefined,
        execute: port.port,
        isWorkspaceTrustedForPackageScripts: (): boolean => repositoryTrusted,
        isWorktreeTrustedByHumanGrant: humanGrant,
      });

      const { done } = collect(manager);
      manager.execute(input({ projectId: worktreeRoot, kinds: ["typecheck"] }));
      await done;
      expect(port.calls).toBe(1);
      expect(humanGrant).not.toHaveBeenCalled();

      repositoryTrusted = false;
      expect(() =>
        manager.execute(input({ projectId: worktreeRoot, kinds: ["typecheck"] })),
      ).toThrow(
        expect.objectContaining({
          code: "WORKSPACE_TRUST_REQUIRED",
          trustRefusal: "repository-not-trusted",
        }),
      );
      expect(humanGrant).toHaveBeenCalledExactlyOnceWith(worktreeRoot);
      expect(port.calls).toBe(1);
    } finally {
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  // The at-effect gate must RE-READ the worktree basis, not replay a comparison taken once at
  // resolution time. The worktree manifest here is byte-identical to its repository's when the plan
  // is built and is replaced before the run is admitted — exactly the "another process rewrote
  // package.json between the two checks" window (P1, PR #3381 review). The trust decider is the
  // deterministic clock for that window: `trustedForScripts` calls it AFTER the plan-time basis read
  // and the at-effect basis read happens after the plan is built, so a rewrite issued from inside
  // the first decider call lands strictly between the two checks. `manifestRewritten` proves the
  // window really was entered mid-flight (the plan-time gate had already admitted), and `port.calls`
  // proves npm was never handed the bytes nobody approved.
  it("re-reads the worktree trust basis at the effect boundary and never spawns a manifest rewritten between the checks", async () => {
    const worktreeRoot = mkdtempSync(join(tmpdir(), "keiko-verify-toctou-"));
    try {
      writeFileSync(join(worktreeRoot, "package.json"), PACKAGE_JSON, "utf8");
      mkdirSync(join(worktreeRoot, "src"), { recursive: true });
      writeFileSync(join(worktreeRoot, "src", "a.test.ts"), "test('x', () => {});\n", "utf8");
      const port = fakePort(report(["typecheck"]));
      let rewriteOnNextTrustCheck = false;
      let manifestRewritten = false;
      const manager = makeManager({
        resolveWorkspaceRootAccess: (root): WorkspaceRootAccess | undefined =>
          root === worktreeRoot
            ? {
                kind: "managed-task",
                canonicalRoot: worktreeRoot,
                fs: nodeWorkspaceFs,
                repositoryRoot: workspaceRoot,
              }
            : undefined,
        execute: port.port,
        isWorkspaceTrustedForPackageScripts: (): boolean => {
          if (rewriteOnNextTrustCheck) {
            rewriteOnNextTrustCheck = false;
            manifestRewritten = true;
            // Still a valid manifest carrying every planned script, so the refusal below can only
            // come from the trust basis — never from NO_RUNNABLE_STEPS.
            writeFileSync(
              join(worktreeRoot, "package.json"),
              PACKAGE_JSON.replace('"tsc --noEmit"', '"tsc --noEmit && node ./attacker.js"'),
              "utf8",
            );
          }
          return true;
        },
      });

      // Control: no rewrite, so the repository's standing grant still covers the worktree.
      const { done } = collect(manager);
      manager.execute(input({ projectId: worktreeRoot, kinds: ["typecheck"] }));
      await done;
      expect(port.calls).toBe(1);

      rewriteOnNextTrustCheck = true;
      expect(() =>
        manager.execute(input({ projectId: worktreeRoot, kinds: ["typecheck"] })),
      ).toThrow(expect.objectContaining({ code: "WORKSPACE_TRUST_REQUIRED", status: 403 }));
      expect(manifestRewritten).toBe(true);
      expect(port.calls).toBe(1);
      expect(manager.inFlightCount()).toBe(0);
    } finally {
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  it("denies a script-backed kind when the workspace is untrusted, without starting a run", () => {
    const port = fakePort(report(["typecheck"]));
    const manager = makeManager({ execute: port.port });
    expect(() => manager.execute(input({ kinds: ["typecheck"] }))).toThrow(VerificationRunnerError);
    expect(port.calls).toBe(0);
    expect(manager.inFlightCount()).toBe(0);
  });

  it("runs script-backed kinds when the workspace IS trusted", async () => {
    const port = fakePort(report(["typecheck"]));
    const manager = makeManager({
      execute: port.port,
      isWorkspaceTrustedForPackageScripts: () => true,
    });
    const { done } = collect(manager);
    manager.execute(input({ kinds: ["typecheck"], correlationId: "verification-route-1" }));
    await done;
    expect(port.calls).toBe(1);
    expect(port.correlationIds).toEqual(["verification-route-1"]);
  });

  it("revalidates workspace trust after plan derivation and denies drift before a human run", () => {
    const port = fakePort(report(["typecheck"]));
    const trust = vi
      .fn<VerificationRunnerWorkspaceTrustDecider>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const manager = makeManager({
      execute: port.port,
      isWorkspaceTrustedForPackageScripts: trust,
    });

    expect(() => manager.execute(input({ kinds: ["typecheck"] }))).toThrow(
      expect.objectContaining({ code: "WORKSPACE_TRUST_REQUIRED", status: 403 }),
    );

    expect(trust).toHaveBeenCalledTimes(2);
    expect(port.calls).toBe(0);
    expect(manager.inFlightCount()).toBe(0);
  });

  it("revalidates workspace trust after plan derivation and denies drift before an agent run", async () => {
    const port = fakePort(report(["typecheck"]));
    const trust = vi
      .fn<VerificationRunnerWorkspaceTrustDecider>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const manager = makeManager({
      execute: port.port,
      isWorkspaceTrustedForPackageScripts: trust,
    });

    await expect(
      manager.runToReport(input({ kinds: ["typecheck"] }), new AbortController().signal),
    ).rejects.toMatchObject({ code: "WORKSPACE_TRUST_REQUIRED", status: 403 });

    expect(trust).toHaveBeenCalledTimes(2);
    expect(port.calls).toBe(0);
    expect(manager.inFlightCount()).toBe(0);
  });

  it("does NOT gate targeted-test on workspace trust (parity with post-apply)", async () => {
    const port = fakePort(report(["targeted-test"]));
    const manager = makeManager({
      execute: port.port,
      isWorkspaceTrustedForPackageScripts: () => false,
    });
    const { done } = collect(manager);
    const start = manager.execute(input({ kinds: ["targeted-test"], targetPath: "src/a.test.ts" }));
    expect(start.runId).toBeTruthy();
    await done;
    expect(port.calls).toBe(1);
  });
});

describe("VerificationRunnerManager — content-free lifecycle events (AC7)", () => {
  it("emits run-started, step events, and a terminal run-completed carrying only the report", async () => {
    const port = fakePort(report(["targeted-test"]));
    const manager = makeManager({ execute: port.port });
    const { events, done } = collect(manager);
    manager.execute(input({ kinds: ["targeted-test"], targetPath: "src/a.test.ts" }));
    await done;
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("run-started");
    expect(kinds).toContain("step-started");
    expect(kinds).toContain("step-completed");
    expect(kinds.at(-1)).toBe("run-completed");
  });

  it("never puts outputSummary or a report on a non-terminal event; only run-completed carries it", async () => {
    const port = fakePort(report(["targeted-test"]));
    const manager = makeManager({ execute: port.port });
    const { events, done } = collect(manager);
    manager.execute(input({ kinds: ["targeted-test"], targetPath: "src/a.test.ts" }));
    await done;
    for (const event of events) {
      if (event.kind === "run-completed") continue;
      // Every NON-terminal event is content-free: no report, no outputSummary, no raw-looking output.
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain("SENSITIVE-LOOKING");
      expect(serialized).not.toContain("outputSummary");
      expect("report" in event).toBe(false);
    }
    // The terminal run-completed event carries the full report (its outputSummary is the already
    // redacted+byte-capped digest, further scrubbed by the SSE route's redactor on the wire).
    const completed = events.find((e) => e.kind === "run-completed");
    expect(completed && "report" in completed).toBe(true);
  });
});

describe("VerificationRunnerManager — cancellation (AC5)", () => {
  it("cancels an in-flight run and emits run-cancelled, not run-failed", async () => {
    const port = fakePort(report(["targeted-test"]), true);
    const manager = makeManager({ execute: port.port });
    const { events, done } = collect(manager);
    const start = manager.execute(input({ kinds: ["targeted-test"], targetPath: "src/a.test.ts" }));
    expect(manager.inFlightCount()).toBe(1);
    expect(manager.abort(start.runId)).toBe(true);
    await done;
    expect(events.at(-1)?.kind).toBe("run-cancelled");
    expect(events.some((e) => e.kind === "run-failed")).toBe(false);
    expect(manager.inFlightCount()).toBe(0);
  });

  it("returns false when aborting an unknown run id", () => {
    const port = fakePort(report(["typecheck"]));
    const manager = makeManager({ execute: port.port });
    expect(manager.abort("no-such-run")).toBe(false);
  });

  it("emits exactly one cancelled terminal for an externally pre-aborted run", async () => {
    const port: VerificationExecutePort = ({ signal }) => {
      expect(signal.aborted).toBe(true);
      return Promise.reject(new Error(`cancelled at ${workspaceRoot}/secret.ts`));
    };
    const events: EditorVerificationEvent[] = [];
    const diagnostics: ServerDiagnosticRecord[] = [];
    const controller = new AbortController();
    controller.abort();
    const guarded = createVerificationRunnerManager({
      store,
      evidenceStore,
      execute: port,
      diagnostics: { record: (record): void => void diagnostics.push(record) },
    });
    guarded.subscribe((event) => events.push(event));
    await expect(
      guarded.runToReport(
        input({ kinds: ["targeted-test"], targetPath: "src/a.test.ts" }),
        controller.signal,
      ),
    ).rejects.toThrow();
    const terminals = events.filter((event) =>
      ["run-completed", "run-cancelled", "run-failed"].includes(event.kind),
    );
    expect(terminals).toEqual([expect.objectContaining({ kind: "run-cancelled" })]);
    expect(diagnostics).toEqual([]);
    expect(guarded.inFlightCount()).toBe(0);
  });
});

describe("VerificationRunnerManager — async failure observability", () => {
  it("records a content-free subscriber failure and continues lifecycle fan-out", async () => {
    const secret = "subscriber-secret-payload";
    const diagnostics: ServerDiagnosticRecord[] = [];
    const manager = makeManager({
      execute: fakePort(report(["targeted-test"])).port,
      diagnostics: { record: (record): void => void diagnostics.push(record) },
      now: () => 10,
    });
    manager.subscribe((event) => {
      if (event.kind === "run-started") throw new Error(`${secret} at ${workspaceRoot}`);
    });
    const { events, done } = collect(manager);
    manager.execute(
      input({
        kinds: ["targeted-test"],
        targetPath: "src/a.test.ts",
        correlationId: "subscriber-correlation-1",
      }),
    );
    await done;

    expect(events.at(-1)?.kind).toBe("run-completed");
    expect(diagnostics).toEqual([
      expect.objectContaining({
        correlationId: "subscriber-correlation-1",
        operation: "editor.verification.subscriber",
        errorClass: "VerificationSubscriber",
        message: "A verification event subscriber failed.",
      }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
    expect(JSON.stringify(diagnostics)).not.toContain(workspaceRoot);
  });

  it("persists and emits only static failure data while recording the route correlation id", async () => {
    const secret = "secret-token-in-error";
    const diagnostics: ServerDiagnosticRecord[] = [];
    const manager = makeManager({
      execute: () => Promise.reject(new Error(`${secret} at ${workspaceRoot}/private.ts`)),
      diagnostics: { record: (record): void => void diagnostics.push(record) },
      redactor: (value) => value.replaceAll(secret, "[REDACTED]"),
      now: vi.fn(() => 10),
    });
    const { events, done } = collect(manager);
    const start = manager.execute(
      input({
        kinds: ["targeted-test"],
        targetPath: "src/a.test.ts",
        correlationId: "verification-correlation-1",
      }),
    );
    await done;

    expect(events.filter((event) => event.kind === "run-failed")).toEqual([
      expect.objectContaining({ reason: "verification-run-execution-failed" }),
    ]);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        correlationId: "verification-correlation-1",
        message: "Verification execution failed unexpectedly.",
      }),
    ]);
    const failureEvents = events.filter((event) => event.kind === "run-failed");
    const serialized = `${JSON.stringify(failureEvents)}${JSON.stringify(diagnostics)}${evidenceStore.get(start.runId) ?? ""}`;
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(workspaceRoot);
    expect(evidenceStore.get(start.runId)).toContain('"outcome": "failed"');
    expect(manager.inFlightCount()).toBe(0);
  });
});

describe("VerificationRunnerManager — bounded concurrency (Issue #2211)", () => {
  it("rejects a run once the registry is at the concurrency cap", () => {
    const port = fakePort(report(["targeted-test"]), true);
    const manager = makeManager({ execute: port.port, maxConcurrentRuns: 1 });
    manager.execute(input({ kinds: ["targeted-test"], targetPath: "src/a.test.ts" }));
    expect(manager.inFlightCount()).toBe(1);
    expect(() =>
      manager.execute(input({ kinds: ["targeted-test"], targetPath: "src/a.test.ts" })),
    ).toThrow(VerificationRunnerError);
    try {
      manager.execute(input({ kinds: ["targeted-test"], targetPath: "src/a.test.ts" }));
    } catch (error) {
      expect(error).toBeInstanceOf(VerificationRunnerError);
      expect((error as VerificationRunnerError).code).toBe("RUN_LIMIT_EXCEEDED");
    }
  });
});

describe("VerificationRunnerManager — audit-evidence trail (Issue #2211 fix-up)", () => {
  it("writes a content-free evidence entry for a completed run", async () => {
    const port = fakePort(report(["targeted-test"]));
    const manager = makeManager({ execute: port.port });
    const { done } = collect(manager);
    const start = manager.execute(input({ kinds: ["targeted-test"], targetPath: "src/a.test.ts" }));
    await done;
    const raw = evidenceStore.get(start.runId);
    expect(raw).toBeDefined();
    const manifest = JSON.parse(raw ?? "{}") as {
      run: { taskType: string };
      verification?: object;
    };
    expect(manifest.run.taskType).toBe("editor-verification-run");
    expect(manifest.verification).toBeDefined();
    expect(raw).not.toContain("SENSITIVE-LOOKING");
  });

  it("emits a run-failed event (not a silently-succeeding run-completed) when evidence cannot be written", async () => {
    const port = fakePort(report(["targeted-test"]));
    const failingStore: EvidenceStore = {
      ...evidenceStore,
      put: (): string => {
        throw new Error("disk full");
      },
    };
    const manager = makeManager({ execute: port.port, evidenceStore: failingStore });
    const { events, done } = collect(manager);
    manager.execute(input({ kinds: ["targeted-test"], targetPath: "src/a.test.ts" }));
    await done;
    expect(events.at(-1)?.kind).toBe("run-failed");
    expect((events.at(-1) as { reason?: string }).reason).toBe(
      "verification-evidence-write-failed",
    );
  });

  it("emits the same evidence-write-failure signal when no evidence store is configured at all", async () => {
    const port = fakePort(report(["targeted-test"]));
    const manager = makeManager({ execute: port.port, evidenceStore: undefined });
    const { events, done } = collect(manager);
    manager.execute(input({ kinds: ["targeted-test"], targetPath: "src/a.test.ts" }));
    await done;
    expect(events.at(-1)?.kind).toBe("run-failed");
    expect((events.at(-1) as { reason?: string }).reason).toBe(
      "verification-evidence-write-failed",
    );
  });
});

describe("VerificationRunnerManager — runToReport shares the human run's lifecycle (Issue #2214/#2215 fix-up)", () => {
  it("emits the same run-started/step/terminal events execute() does, so an agent run is visible to human subscribers", async () => {
    const port = fakePort(report(["targeted-test"]));
    const manager = makeManager({ execute: port.port });
    const events: EditorVerificationEvent[] = [];
    manager.subscribe((event) => events.push(event));
    const controller = new AbortController();
    const { report: resultReport } = await manager.runToReport(
      input({ kinds: ["targeted-test"], targetPath: "src/a.test.ts" }),
      controller.signal,
    );
    expect(resultReport.overallStatus).toBe("failed");
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("run-started");
    expect(kinds).toContain("step-started");
    expect(kinds).toContain("step-completed");
    expect(kinds.at(-1)).toBe("run-completed");
  });

  it("registers the run in the SAME registry execute() uses, so a human can cancel it once the run-started event reveals its runId", async () => {
    const port = fakePort(report(["targeted-test"]), true);
    const manager = makeManager({ execute: port.port });
    const events: EditorVerificationEvent[] = [];
    manager.subscribe((event) => events.push(event));
    const controller = new AbortController();
    const runPromise = manager.runToReport(
      input({ kinds: ["targeted-test"], targetPath: "src/a.test.ts" }),
      controller.signal,
    );
    const started = events.find((e) => e.kind === "run-started");
    expect(started?.runId).toBeTruthy();
    const runId = started?.runId ?? "";
    expect(manager.inFlightCount()).toBe(1);
    expect(manager.abort(runId)).toBe(true);
    await runPromise;
    expect(events.at(-1)?.kind).toBe("run-cancelled");
    expect(manager.inFlightCount()).toBe(0);
  });

  it("writes the same audit-evidence entry execute() writes", async () => {
    const port = fakePort(report(["targeted-test"]));
    const manager = makeManager({ execute: port.port });
    const controller = new AbortController();
    const events: EditorVerificationEvent[] = [];
    manager.subscribe((event) => events.push(event));
    await manager.runToReport(
      input({ kinds: ["targeted-test"], targetPath: "src/a.test.ts" }),
      controller.signal,
    );
    const started = events.find((e) => e.kind === "run-started");
    const raw = evidenceStore.get(started?.runId ?? "");
    expect(raw).toBeDefined();
  });

  it("rejects (fail-closed) when evidence cannot be written, instead of returning an unaudited report", async () => {
    const port = fakePort(report(["targeted-test"]));
    const failingStore: EvidenceStore = {
      ...evidenceStore,
      put: (): string => {
        throw new Error("disk full");
      },
    };
    const manager = makeManager({ execute: port.port, evidenceStore: failingStore });
    const controller = new AbortController();
    await expect(
      manager.runToReport(
        input({ kinds: ["targeted-test"], targetPath: "src/a.test.ts" }),
        controller.signal,
      ),
    ).rejects.toThrow(VerificationRunnerError);
  });
});

// #3452: the agent path's own plumbing around the injected execute port -- runToReport must ask
// for a dependency bootstrap and forward every orchestrator output through onStepOutput, bounded,
// and must leave exactly one body-free activity line behind for a report that bootstrapped
// dependencies (and none for one that did not).
describe("VerificationRunnerManager — runToReport's dependency-bootstrap and step-output plumbing (#3452)", () => {
  it('passes dependencyBootstrap "auto" and an onStepOutput sink to the execute port, and returns everything pushed through it as failureOutput', async () => {
    const outputs: VerificationStepOutput[] = [
      { step: "dependencies", scriptName: undefined, excerpt: "npm install failed" },
      { step: "targeted-test", scriptName: "vitest", excerpt: "1 failing" },
    ];
    let observedBootstrap: "off" | "auto" | undefined;
    let observedOnStepOutput: ((output: VerificationStepOutput) => void) | undefined;
    const port: VerificationExecutePort = (args) => {
      observedBootstrap = args.dependencyBootstrap;
      observedOnStepOutput = args.onStepOutput;
      for (const output of outputs) args.onStepOutput?.(output);
      return Promise.resolve({
        report: report(["targeted-test"]),
        probe: { available: true, backend: "test-backend" },
      });
    };
    const manager = makeManager({ execute: port });

    const { failureOutput } = await manager.runToReport(
      input({ kinds: ["targeted-test"], targetPath: "src/a.test.ts" }),
      new AbortController().signal,
    );

    expect(observedBootstrap).toBe("auto");
    expect(typeof observedOnStepOutput).toBe("function");
    expect(failureOutput).toEqual(outputs);
  });

  it("caps failureOutput at 8 entries even when the port pushes more through onStepOutput", async () => {
    // MAX_FAILURE_OUTPUTS (verificationRunner.ts) is 8 and module-private; pinned by its observable
    // effect rather than by importing it.
    const many: VerificationStepOutput[] = Array.from({ length: 12 }, (_, index) => ({
      step: "targeted-test",
      scriptName: "vitest",
      excerpt: `failure ${String(index)}`,
    }));
    const port: VerificationExecutePort = (args) => {
      for (const output of many) args.onStepOutput?.(output);
      return Promise.resolve({
        report: report(["targeted-test"]),
        probe: { available: true, backend: "test-backend" },
      });
    };
    const manager = makeManager({ execute: port });

    const { failureOutput } = await manager.runToReport(
      input({ kinds: ["targeted-test"], targetPath: "src/a.test.ts" }),
      new AbortController().signal,
    );

    expect(failureOutput).toHaveLength(8);
    expect(failureOutput).toEqual(many.slice(0, 8));
  });

  it("writes exactly one body-free editor.verification.dependencies activity line when the report carries a dependencies summary", async () => {
    const events: ServerLogEvent[] = [];
    const withDependencies: VerificationReport = {
      ...report(["targeted-test"]),
      dependencies: { state: "installed", lockfile: "created", exitCode: 0, durationMs: 4_200 },
    };
    const manager = makeManager({
      activityLog: { write: (event): void => void events.push(event) },
      execute: fakePort(withDependencies).port,
    });

    await manager.runToReport(
      input({
        kinds: ["targeted-test"],
        targetPath: "src/a.test.ts",
        correlationId: "deps-present",
      }),
      new AbortController().signal,
    );

    const dependencyLines = events.filter(
      (event) => event.op === "editor.verification.dependencies",
    );
    expect(dependencyLines).toHaveLength(1);
    expect(dependencyLines[0]).toMatchObject({
      op: "editor.verification.dependencies",
      correlationId: "deps-present",
      extra: { state: "installed", lockfile: "created", exitCode: 0, durationMs: 4_200 },
    });
    expect(JSON.stringify(dependencyLines)).not.toContain(workspaceRoot);
  });

  it("carries the install's registry egress counts on the dependencies line", async () => {
    const events: ServerLogEvent[] = [];
    const withEgress: VerificationReport = {
      ...report(["targeted-test"]),
      dependencies: {
        state: "refused",
        lockfile: "absent",
        exitCode: 1,
        durationMs: 900,
        egress: { allowed: 4, refused: 1 },
      },
    };
    const manager = makeManager({
      activityLog: { write: (event): void => void events.push(event) },
      execute: fakePort(withEgress).port,
    });

    await manager.runToReport(
      input({
        kinds: ["targeted-test"],
        targetPath: "src/a.test.ts",
        correlationId: "deps-egress",
      }),
      new AbortController().signal,
    );

    const line = events.find((event) => event.op === "editor.verification.dependencies");
    expect(line).toMatchObject({
      correlationId: "deps-egress",
      extra: { state: "refused", egressAllowed: 4, egressRefused: 1 },
    });
  });

  it("writes no editor.verification.dependencies line when the report carries no dependencies summary", async () => {
    const events: ServerLogEvent[] = [];
    const manager = makeManager({
      activityLog: { write: (event): void => void events.push(event) },
      execute: fakePort(report(["targeted-test"])).port,
    });

    await manager.runToReport(
      input({
        kinds: ["targeted-test"],
        targetPath: "src/a.test.ts",
        correlationId: "deps-absent",
      }),
      new AbortController().signal,
    );

    expect(events.some((event) => event.op === "editor.verification.dependencies")).toBe(false);
  });

  // #3452 follow-up: `executeAndReport` (the human path behind `execute`/`runPlan`) built the
  // SAME dependencyBootstrap request and recorded the same activity line by hand, alongside
  // executeAgentPlan's copy above -- and only the agent path was ever driven through a test. Both
  // call sites now build their orchestrator options from one shared helper (buildExecuteArgs); this
  // proves the human path gets identical behaviour rather than merely trusting the refactor.
  it('passes dependencyBootstrap "auto" to the execute port and writes the dependencies activity line for a human-triggered run', async () => {
    const withDependencies: VerificationReport = {
      ...report(["targeted-test"]),
      dependencies: { state: "installed", lockfile: "created", exitCode: 0, durationMs: 4_200 },
    };
    let observedBootstrap: "off" | "auto" | undefined;
    const port: VerificationExecutePort = (args) => {
      observedBootstrap = args.dependencyBootstrap;
      return Promise.resolve({
        report: withDependencies,
        probe: { available: true, backend: "test-backend" },
      });
    };
    const events: ServerLogEvent[] = [];
    const manager = makeManager({
      execute: port,
      activityLog: { write: (event): void => void events.push(event) },
    });
    const { done } = collect(manager);

    manager.execute(
      input({
        kinds: ["targeted-test"],
        targetPath: "src/a.test.ts",
        correlationId: "human-deps-present",
      }),
    );
    await done;

    expect(observedBootstrap).toBe("auto");
    const dependencyLines = events.filter(
      (event) => event.op === "editor.verification.dependencies",
    );
    expect(dependencyLines).toHaveLength(1);
    expect(dependencyLines[0]).toMatchObject({
      op: "editor.verification.dependencies",
      correlationId: "human-deps-present",
      extra: { state: "installed", lockfile: "created", exitCode: 0, durationMs: 4_200 },
    });
  });
});

describe("VerificationRunnerManager — catalog + edge cases", () => {
  it("records every closed terminal status count in the completion activity", async () => {
    const base = report(["typecheck", "lint"]);
    const terminalFailures: VerificationReport = {
      ...base,
      results: base.results.map((result, index) => ({
        ...result,
        status: index === 0 ? "timed-out" : "resource-exceeded",
      })),
      counts: counts({ "timed-out": 1, "resource-exceeded": 1 }),
    };
    const events: ServerLogEvent[] = [];
    const manager = makeManager({
      activityLog: { write: (event): void => void events.push(event) },
      execute: fakePort(terminalFailures).port,
      isWorkspaceTrustedForPackageScripts: () => true,
    });

    await manager.runToReport(
      input({ kinds: ["typecheck", "lint"], correlationId: "terminal-status-counts" }),
      new AbortController().signal,
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        op: "editor.verification.execute",
        correlationId: "terminal-status-counts",
        extra: {
          state: "completed",
          runnerId: "vitest",
          verificationStatus: "failed",
          stepCount: 2,
          passedCount: 0,
          failedCount: 0,
          skippedCount: 0,
          deniedCount: 0,
          timedOutCount: 1,
          cancelledCount: 0,
          resourceExceededCount: 1,
        },
      }),
    );
  });

  it("records the selected Node runner and successful completion in the activity timeline", async () => {
    writeFileSync(
      join(workspaceRoot, "package.json"),
      JSON.stringify({ name: "fixture", scripts: { test: "node --test" } }),
      "utf8",
    );
    writeFileSync(join(workspaceRoot, "src", "native.test.js"), "", "utf8");
    const events: ServerLogEvent[] = [];
    const manager = makeManager({
      activityLog: { write: (event): void => void events.push(event) },
      execute: fakePort({ ...report(["targeted-test"]), overallStatus: "passed" }).port,
    });

    await manager.runToReport(
      input({
        kinds: ["targeted-test"],
        targetPath: "src/native.test.js",
        correlationId: "node-runner-success",
      }),
      new AbortController().signal,
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        op: "editor.verification.execute",
        correlationId: "node-runner-success",
        extra: expect.objectContaining({
          state: "completed",
          runnerId: "node-test",
          verificationStatus: "passed",
        }) as unknown,
      }),
    );
  });

  it("records a closed Node runner refusal before execution", () => {
    writeFileSync(
      join(workspaceRoot, "package.json"),
      JSON.stringify({ name: "fixture", scripts: { test: "node --test" } }),
      "utf8",
    );
    const events: ServerLogEvent[] = [];
    const port = fakePort(report(["targeted-test"]));
    const manager = makeManager({
      activityLog: { write: (event): void => void events.push(event) },
      execute: port.port,
    });

    expect(() =>
      manager.execute(
        input({
          kinds: ["targeted-test"],
          targetPath: "src/missing.test.js",
          correlationId: "node-runner-refused",
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "NO_RUNNABLE_STEPS" }));
    expect(port.calls).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        op: "editor.verification.execute",
        correlationId: "node-runner-refused",
        errorKind: "NO_RUNNABLE_STEPS",
        extra: expect.objectContaining({
          state: "refused",
          runnerId: "node-test",
          reason: "NO_RUNNABLE_STEPS",
        }) as unknown,
      }),
    );
  });

  it("plans a Node native targeted test instead of reporting no runnable steps", async () => {
    writeFileSync(
      join(workspaceRoot, "package.json"),
      JSON.stringify({ name: "fixture", scripts: { test: "node --test" } }),
      "utf8",
    );
    writeFileSync(join(workspaceRoot, "src", "native.test.js"), "", "utf8");
    const port = fakePort(report(["targeted-test"]));
    const manager = makeManager({ execute: port.port });

    await manager.runToReport(
      input({ kinds: ["targeted-test"], targetPath: "src/native.test.js" }),
      new AbortController().signal,
    );

    expect(manager.discover(workspaceRoot).kinds).toContainEqual(
      expect.objectContaining({ kind: "targeted-test", available: true }),
    );
    expect(port.calls).toBe(1);
  });

  it("projects available kinds and trust state; targeted-test is trusted and framework-gated", () => {
    const manager = makeManager();
    const catalog = manager.discover(workspaceRoot);
    const byKind = new Map(catalog.kinds.map((k) => [k.kind, k]));
    expect(byKind.get("typecheck")?.available).toBe(true);
    expect(byKind.get("typecheck")?.trustState).toBe("approval-required");
    expect(byKind.get("build")?.available).toBe(false); // no build script in the fixture
    expect(byKind.get("targeted-test")?.trustState).toBe("trusted");
    expect(byKind.get("targeted-test")?.available).toBe(true); // vitest present
  });

  it("throws PROJECT_NOT_FOUND for an unknown project id", () => {
    const manager = makeManager();
    expect(() => manager.discover("/nope")).toThrow(VerificationRunnerError);
  });

  it("throws NO_RUNNABLE_STEPS when targeted-test resolves no file", () => {
    const port = fakePort(report(["targeted-test"]));
    const manager = makeManager({ execute: port.port });
    expect(() =>
      manager.execute(input({ kinds: ["targeted-test"], targetPath: "src/missing.test.ts" })),
    ).toThrow(VerificationRunnerError);
  });
});

// The ONE package-script trust rule every consumer asks (verification runner, command runner, agent
// verification route). An ordinary root is decided by its own standing grant alone — the worktree
// decider is never consulted for it — and any decider that throws fails the decision closed under
// its own reason instead of surfacing as an admitted run or an unexplained refusal.
describe("decideScriptTrust", () => {
  const ordinary: WorkspaceRootAccess = {
    kind: "ordinary",
    canonicalRoot: "/ordinary",
    fs: nodeWorkspaceFs,
  };

  it("decides an ordinary root by its own standing grant alone", () => {
    const worktreeHumanGrant = vi.fn((): boolean => true);
    expect(
      decideScriptTrust({
        access: ordinary,
        repositoryFs: nodeWorkspaceFs,
        standingTrust: (): boolean => true,
        worktreeHumanGrant,
        runAdmittedManifest: (): boolean => false,
      }),
    ).toEqual({ trusted: true, basis: "own-root" });
    expect(
      decideScriptTrust({
        access: ordinary,
        repositoryFs: nodeWorkspaceFs,
        standingTrust: (): boolean => false,
        worktreeHumanGrant,
        runAdmittedManifest: (): boolean => false,
      }),
    ).toEqual({ trusted: false, refusal: "root-not-trusted" });
    expect(worktreeHumanGrant).not.toHaveBeenCalled();
  });

  it("fails closed under its own reason when a decider throws", () => {
    expect(
      decideScriptTrust({
        access: ordinary,
        repositoryFs: nodeWorkspaceFs,
        standingTrust: (): boolean => {
          throw new Error("trust store unavailable");
        },
        worktreeHumanGrant: (): boolean => true,
        runAdmittedManifest: (): boolean => true,
      }),
    ).toEqual({ trusted: false, refusal: "decision-failed" });
  });

  // ADR-0147 D3, autonomous-delivery amendment (owner decision, 2026-09-10): the run's own manifest
  // is a basis only UNDER the repository's standing grant and only after the explicit worktree
  // grant was asked; a repository nobody trusted admits no run manifest, and an ordinary root never
  // consults it.
  describe("run-manifest basis", () => {
    const worktreeDir = mkdtempSync(join(tmpdir(), "keiko-run-manifest-"));
    const repositoryDir = mkdtempSync(join(tmpdir(), "keiko-run-manifest-repo-"));
    writeFileSync(join(repositoryDir, "package.json"), PACKAGE_JSON, "utf8");
    writeFileSync(
      join(worktreeDir, "package.json"),
      PACKAGE_JSON.replace('"vitest run"', '"vitest run --coverage"'),
      "utf8",
    );
    const drifted: WorkspaceRootAccess = {
      kind: "managed-task",
      canonicalRoot: worktreeDir,
      fs: nodeWorkspaceFs,
      repositoryRoot: repositoryDir,
    };
    afterAll(() => {
      rmSync(worktreeDir, { recursive: true, force: true });
      rmSync(repositoryDir, { recursive: true, force: true });
    });

    it("admits a drifted worktree under the repository's grant when the run left the manifest", () => {
      const runAdmittedManifest = vi.fn((): boolean => true);
      expect(
        decideScriptTrust({
          access: drifted,
          repositoryFs: nodeWorkspaceFs,
          standingTrust: (): boolean => true,
          worktreeHumanGrant: (): boolean => false,
          runAdmittedManifest,
        }),
      ).toEqual({ trusted: true, basis: "run-manifest" });
      expect(runAdmittedManifest).toHaveBeenCalledOnce();
    });

    it("prefers the explicit worktree grant and never asks the run when it holds", () => {
      const runAdmittedManifest = vi.fn((): boolean => true);
      expect(
        decideScriptTrust({
          access: drifted,
          repositoryFs: nodeWorkspaceFs,
          standingTrust: (): boolean => true,
          worktreeHumanGrant: (): boolean => true,
          runAdmittedManifest,
        }),
      ).toEqual({ trusted: true, basis: "worktree-human-grant" });
      expect(runAdmittedManifest).not.toHaveBeenCalled();
    });

    it("admits no run manifest for a repository nobody trusted", () => {
      const runAdmittedManifest = vi.fn((): boolean => true);
      expect(
        decideScriptTrust({
          access: drifted,
          repositoryFs: nodeWorkspaceFs,
          standingTrust: (): boolean => false,
          worktreeHumanGrant: (): boolean => false,
          runAdmittedManifest,
        }),
      ).toEqual({ trusted: false, refusal: "repository-not-trusted" });
      expect(runAdmittedManifest).not.toHaveBeenCalled();
    });

    it("still refuses the drift when the run left a different manifest than the one now present", () => {
      expect(
        decideScriptTrust({
          access: drifted,
          repositoryFs: nodeWorkspaceFs,
          standingTrust: (): boolean => true,
          worktreeHumanGrant: (): boolean => false,
          runAdmittedManifest: (): boolean => false,
        }),
      ).toEqual({ trusted: false, refusal: "worktree-manifest-drift" });
    });
  });
});
