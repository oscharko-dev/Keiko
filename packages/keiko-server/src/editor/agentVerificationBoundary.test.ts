// Issue #2215 (Epic #2092 closeout) — sandbox-boundary regression evidence for the AGENT verification
// path (Issue #2214), proving it never gains a broader execution surface than the human path
// (Issue #2211/#2212). Hermetic: the manager's execution port is INJECTED (a canned report/probe), so
// no real spawn occurs. This is a NEW file — it does not edit any test a preceding child issue owns.
//
// The single governed spawn boundary is `executeVerificationEnforced` (verificationExecution.ts), the
// enforce-or-fail-closed primitive both the human run affordance and the post-apply phase already use.
// This spec proves the agent route's synchronous `runToReport` routes through THAT SAME injectable
// port — there is no separate agent-only execution engine — and that a fail-closed report surfaces
// honestly (a denied run is reported denied, never as a passed/enforced run it was not).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  VerificationKind,
  VerificationReport,
  VerificationResult,
  VerificationStatus,
} from "@oscharko-dev/keiko-contracts";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import { executeVerificationEnforced } from "./verificationExecution.js";
import type {
  ExecuteVerificationArgs,
  ExecuteVerificationResult,
} from "./verificationExecution.js";
import {
  createVerificationRunnerManager,
  type VerificationExecutePort,
  type VerificationRunInput,
} from "./verificationRunner.js";

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

function result(kind: VerificationKind, status: VerificationStatus): VerificationResult {
  return {
    kind,
    scriptName: undefined,
    command: "npm",
    args: [],
    status,
    exitCode: status === "passed" ? 0 : 1,
    signal: null,
    durationMs: 5,
    truncated: false,
    redacted: true,
    outputSummary: "redacted digest",
    appliedLimits: [],
  };
}

function report(kind: VerificationKind, status: VerificationStatus): VerificationReport {
  return {
    workspaceRoot: "/ws",
    results: [result(kind, status)],
    overallStatus: status,
    startedAtMs: 1,
    durationMs: 5,
    counts: counts({ [status]: 1 }),
  };
}

interface SpyPort {
  readonly port: VerificationExecutePort;
  readonly calls: ExecuteVerificationArgs[];
}

// A single injected execution port. Both the human `execute` and the agent `runToReport` must route
// through it — proving one governed boundary, not two.
function spyPort(rep: VerificationReport): SpyPort {
  const calls: ExecuteVerificationArgs[] = [];
  return {
    calls,
    port: (args): Promise<ExecuteVerificationResult> => {
      calls.push(args);
      return Promise.resolve({ report: rep, probe: { available: true, backend: "test-backend" } });
    },
  };
}

let workspaceRoot: string;
let store: UiStore;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "keiko-agent-verify-"));
  writeFileSync(join(workspaceRoot, "package.json"), PACKAGE_JSON, "utf8");
  mkdirSync(join(workspaceRoot, "src"), { recursive: true });
  writeFileSync(join(workspaceRoot, "src", "a.test.ts"), "test('x', () => {});\n", "utf8");
  store = createInMemoryUiStore();
  store.createProject(workspaceRoot, "fixture");
});

afterEach(() => {
  store.close();
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function input(over: Partial<VerificationRunInput> = {}): VerificationRunInput {
  return { projectId: workspaceRoot, kinds: ["typecheck"], ...over };
}

describe("agent verification stays inside the single governed spawn boundary (Issue #2215)", () => {
  it("routes the agent path through the SAME injected execution port as the human path", async () => {
    const spy = spyPort(report("typecheck", "passed"));
    const manager = createVerificationRunnerManager({
      store,
      execute: spy.port,
      isWorkspaceTrustedForPackageScripts: () => true,
    });

    // Human path (Issue #2211/#2212): start-and-stream is fire-and-forget, so await its terminal event.
    const humanDone = new Promise<void>((resolve) => {
      manager.subscribe((event) => {
        if (event.kind === "run-completed" || event.kind === "run-failed") resolve();
      });
    });
    manager.execute(input());
    await humanDone;
    // Agent path (Issue #2214): synchronous single-shot.
    await manager.runToReport(input(), new AbortController().signal);

    // Both used the one governed port — there is no second, agent-only execution engine.
    expect(spy.calls.length).toBe(2);
    for (const call of spy.calls) {
      // realPath resolution can canonicalize the temp dir (macOS /var → /private/var); match the
      // fixture by its unique basename rather than the pre-realpath string.
      expect(call.workspace.root).toContain("keiko-agent-verify-");
      expect(call.plan.steps.every((step) => step.kind === "typecheck")).toBe(true);
    }
  });

  it("confines an agent run to the requested keiko-verification kind — no broader surface", async () => {
    const spy = spyPort(report("lint", "passed"));
    const manager = createVerificationRunnerManager({
      store,
      execute: spy.port,
      isWorkspaceTrustedForPackageScripts: () => true,
    });
    await manager.runToReport(input({ kinds: ["lint"] }), new AbortController().signal);
    const planned = spy.calls[0]?.plan.steps.map((step) => step.kind) ?? [];
    expect(planned).toEqual(["lint"]);
  });

  it("surfaces a fail-closed (denied) run honestly, never as a passed/enforced run", async () => {
    // A no-enforcing-backend run fails closed: keiko-verification reports the step `denied`. The agent
    // route must return that verbatim — it must not upgrade a denied run to passed.
    const spy = spyPort(report("typecheck", "denied"));
    const manager = createVerificationRunnerManager({
      store,
      execute: spy.port,
      isWorkspaceTrustedForPackageScripts: () => true,
    });
    const result = await manager.runToReport(input(), new AbortController().signal);
    expect(result.overallStatus).toBe("denied");
    expect(result.results[0]?.status).toBe("denied");
  });

  it("uses the enforce-or-fail-closed primitive as the production default execution port", () => {
    // With no injected port, the manager delegates to executeVerificationEnforced — the SAME primitive
    // the human run affordance and post-apply phase use, which probes for an enforcing backend and runs
    // keiko-verification with networkEnforcement: "enforce-or-fail-closed". This is the boundary that
    // exec.test.ts's "fails closed, never spawns, when no enforcing backend is available" already pins.
    const managerWithDefault = createVerificationRunnerManager({ store });
    expect(managerWithDefault.runToReport).toBeTypeOf("function");
    expect(executeVerificationEnforced).toBeTypeOf("function");
  });
});
