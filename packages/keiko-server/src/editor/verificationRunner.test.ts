// Issue #2211 — VerificationRunnerManager unit tests. The execution port is injected (a canned
// report/probe), so the manager exercises the real discovery + trust gate + plan composition +
// content-free lifecycle streaming without a real spawn. Route-level coverage lives in
// verificationRoutes.test.ts.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  EditorVerificationEvent,
  VerificationKind,
  VerificationReport,
  VerificationResult,
  VerificationStatus,
} from "@oscharko-dev/keiko-contracts";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import type { ExecuteVerificationResult } from "./verificationExecution.js";
import {
  createVerificationRunnerManager,
  type VerificationExecutePort,
  type VerificationRunInput,
} from "./verificationRunner.js";
import { VerificationRunnerError } from "./verificationRunnerErrors.js";

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
  calls: number;
}

function fakePort(rep: VerificationReport, waitForAbort = false): FakePort {
  const state: FakePort = {
    calls: 0,
    port: async (args): Promise<ExecuteVerificationResult> => {
      state.calls += 1;
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

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "keiko-verify-"));
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

describe("VerificationRunnerManager — workspace-trust gate (AC3/AC4)", () => {
  it("denies a script-backed kind when the workspace is untrusted, without starting a run", () => {
    const port = fakePort(report(["typecheck"]));
    const manager = createVerificationRunnerManager({ store, execute: port.port });
    expect(() => manager.execute(input({ kinds: ["typecheck"] }))).toThrow(VerificationRunnerError);
    expect(port.calls).toBe(0);
    expect(manager.inFlightCount()).toBe(0);
  });

  it("runs script-backed kinds when the workspace IS trusted", async () => {
    const port = fakePort(report(["typecheck"]));
    const manager = createVerificationRunnerManager({
      store,
      execute: port.port,
      isWorkspaceTrustedForPackageScripts: () => true,
    });
    const { done } = collect(manager);
    manager.execute(input({ kinds: ["typecheck"] }));
    await done;
    expect(port.calls).toBe(1);
  });

  it("does NOT gate targeted-test on workspace trust (parity with post-apply)", async () => {
    const port = fakePort(report(["targeted-test"]));
    const manager = createVerificationRunnerManager({
      store,
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
    const manager = createVerificationRunnerManager({ store, execute: port.port });
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
    const manager = createVerificationRunnerManager({ store, execute: port.port });
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
    const manager = createVerificationRunnerManager({ store, execute: port.port });
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
    const manager = createVerificationRunnerManager({ store, execute: port.port });
    expect(manager.abort("no-such-run")).toBe(false);
  });
});

describe("VerificationRunnerManager — catalog + edge cases", () => {
  it("projects available kinds and trust state; targeted-test is trusted and framework-gated", () => {
    const manager = createVerificationRunnerManager({ store });
    const catalog = manager.discover(workspaceRoot);
    const byKind = new Map(catalog.kinds.map((k) => [k.kind, k]));
    expect(byKind.get("typecheck")?.available).toBe(true);
    expect(byKind.get("typecheck")?.trustState).toBe("approval-required");
    expect(byKind.get("build")?.available).toBe(false); // no build script in the fixture
    expect(byKind.get("targeted-test")?.trustState).toBe("trusted");
    expect(byKind.get("targeted-test")?.available).toBe(true); // vitest present
  });

  it("throws PROJECT_NOT_FOUND for an unknown project id", () => {
    const manager = createVerificationRunnerManager({ store });
    expect(() => manager.discover("/nope")).toThrow(VerificationRunnerError);
  });

  it("throws NO_RUNNABLE_STEPS when targeted-test resolves no file", () => {
    const port = fakePort(report(["targeted-test"]));
    const manager = createVerificationRunnerManager({ store, execute: port.port });
    expect(() =>
      manager.execute(input({ kinds: ["targeted-test"], targetPath: "src/missing.test.ts" })),
    ).toThrow(VerificationRunnerError);
  });
});
