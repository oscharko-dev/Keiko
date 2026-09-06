// Issue #2211 — VerificationRunnerManager unit tests. The execution port is injected (a canned
// report/probe), so the manager exercises the real discovery + trust gate + plan composition +
// content-free lifecycle streaming without a real spawn. Route-level coverage lives in
// verificationRoutes.test.ts.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  createVerificationRunnerManager,
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
      ).toThrow(expect.objectContaining({ code: "WORKSPACE_TRUST_REQUIRED" }));
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
    const resultReport = await manager.runToReport(
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

describe("VerificationRunnerManager — catalog + edge cases", () => {
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
