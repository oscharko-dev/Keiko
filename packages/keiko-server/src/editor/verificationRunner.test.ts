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
import { createInMemoryEvidenceStore, type EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import type { ExecuteVerificationResult } from "./verificationExecution.js";
import {
  createVerificationRunnerManager,
  type VerificationExecutePort,
  type VerificationRunInput,
  type VerificationRunnerManager,
  type VerificationRunnerManagerOptions,
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
    manager.execute(input({ kinds: ["typecheck"] }));
    await done;
    expect(port.calls).toBe(1);
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
