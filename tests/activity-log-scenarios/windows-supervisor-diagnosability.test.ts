// #4495: the Windows supervisor refusal words through the REAL Activity Log writer and the support
// analyzer. Every refusal the Windows supervisor can send is driven through the real native tree,
// written by the manager's own exit emitter and read back from the run's analyzer timeline (the
// body-free machine view `keiko support analyze` projects): each word arrives as its own closed
// value, with no message text, path or command line beside it. The manager call site through the
// same writer is proven in codingRuntimeManager.test.ts (#4495 AC1); the reap proof's root exit
// code and the sweep counts through the backend's wiring and the same writer in
// nativeRuntimeProcessBackend.windows-grants.test.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";

import { emitRuntimeExitDiagnostic } from "../../packages/keiko-server/src/coding-runtime/codingRuntimeManager.js";
import { defaultServerDiagnosticSink } from "../../packages/keiko-server/src/diagnostics-log.js";
import {
  NativeRuntimeTree,
  type NativeRuntimeHelperProcess,
} from "../../packages/keiko-server/src/coding-runtime/nativeRuntimeProcessTree.js";
import { closeFileServerLogSinks } from "../../packages/keiko-server/src/observability/index.js";
import { readPersistedActivityLog } from "../support/activity-log-proof.js";
import { resetServerLogger } from "../support/activity-log-test-support.js";

// What a path, a message or a command line would look like if one rode along.
const LEAK_PATTERN = /[\\/]|[A-Z]:|\.exe|\s--|Access is denied|0x[0-9a-f]{8}/iu;

interface TimelineLine {
  readonly op?: string | undefined;
  readonly frames?: readonly string[] | undefined;
  readonly extra?: Readonly<Record<string, unknown>> | undefined;
}

function refusalPacket(code: number): Buffer {
  const packet = Buffer.alloc(14);
  packet.write("KRS1", 0, "ascii");
  packet.writeUInt16LE(1, 4);
  packet.writeUInt16LE(3, 6);
  packet.writeUInt32LE(2, 8);
  packet.writeUInt16LE(code, 12);
  return packet;
}

function helper(): { readonly process: NativeRuntimeHelperProcess; readonly control: PassThrough } {
  const control = new PassThrough();
  return {
    control,
    process: {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      controlInput: new PassThrough(),
      controlOutput: control,
      onExit: (): void => undefined,
      onError: (): void => undefined,
    },
  };
}

describe("Windows supervisor boundary in the Activity Log and the support analyzer (#4495)", () => {
  let stateDir: string;
  let consoleError: MockInstance<typeof console.error>;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-scenario-windows-supervisor-"));
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
    vi.stubEnv("KEIKO_LOG_LEVEL", "debug");
    // The default sink echoes each diagnostic to stderr; anything else there (a writer failure
    // notice) fails the test.
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    resetServerLogger();
  });

  afterEach(() => {
    const unexpected = consoleError.mock.calls.filter(
      ([first]) => typeof first !== "string" || !first.startsWith("[keiko-server:diagnostic] "),
    );
    closeFileServerLogSinks();
    resetServerLogger();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
    expect(unexpected).toEqual([]);
  });

  function timelineOf(runId: string): readonly TimelineLine[] {
    const result = analyzeLogText(readPersistedActivityLog(stateDir));
    expect(result.evidence.classification).toBe("supported");
    const timeline = result.timelines.find((candidate) => candidate.correlationId === runId);
    if (timeline === undefined) throw new Error(`no timeline for ${runId}`);
    return timeline.lines;
  }

  // The manager's own emitter writes the line; only the refusal word comes from the tree.
  function exitLineOf(runId: string, word: string): void {
    emitRuntimeExitDiagnostic(defaultServerDiagnosticSink, runId, null, Date.now, word);
  }

  // Every refusal of the Windows supervisor (keiko_runtime_supervisor.c `error_code`), and a number
  // it never sends. 16 and 17 are unused (#4496).
  const REFUSALS: readonly (readonly [number, string])[] = [
    [1, "supervisor-protocol"],
    [2, "supervisor-job-create"],
    [3, "supervisor-process-create"],
    [4, "supervisor-job-assign"],
    [5, "supervisor-job-observe"],
    [6, "supervisor-grants-frame"],
    [7, "supervisor-grants-directory"],
    [8, "supervisor-grants-acl"],
    [9, "supervisor-grants-capability"],
    [10, "supervisor-gateway-connect"],
    [11, "supervisor-gateway-admit"],
    [12, "supervisor-environment-guard"],
    [13, "supervisor-relay-frame"],
    [14, "supervisor-relay-profile"],
    [15, "supervisor-relay-start"],
    [18, "supervisor-no-desktop"],
    [19, "supervisor-image-path"],
    [99, "supervisor-unknown"],
  ];

  // The fields an exit line may carry: closed labels and the closed refusal word, nothing else.
  const EXIT_LINE_FIELDS = new Set([
    "completeness",
    "loss",
    "diagnosticOperation",
    "diagnosticErrorClass",
    "source",
    "code",
    "diagnosticSummary",
  ]);

  function refusedWord(code: number): string | undefined {
    const { process: child, control } = helper();
    const tree = new NativeRuntimeTree("a".repeat(32), child, "win32");
    control.emit("data", refusalPacket(code));
    return tree.failureReason();
  }

  function exitLines(runId: string): readonly TimelineLine[] {
    return timelineOf(runId).filter(
      (line) => line.extra?.diagnosticOperation === "coding-runtime.exit",
    );
  }

  it.each(REFUSALS)("projects refusal %i as %s on the run's timeline", (code, word) => {
    const reason = refusedWord(code);
    expect(reason).toBe(word);
    const runId = `run-refused-${String(code)}`;
    exitLineOf(runId, reason ?? "");

    const lines = exitLines(runId);
    expect(lines).toHaveLength(1);
    const extra = lines[0]?.extra ?? {};
    expect(extra).toMatchObject({
      diagnosticOperation: "coding-runtime.exit",
      source: "coding-runtime-manager.exit",
      code: word,
    });
    expect(Object.keys(extra).filter((key) => !EXIT_LINE_FIELDS.has(key))).toEqual([]);
    expect(JSON.stringify(extra)).not.toMatch(LEAK_PATTERN);
    // The only path on the line is the repository-relative Keiko frame of the exit handler
    // (ADR-0173 D3), never an absolute or machine path.
    expect(lines[0]?.frames).toEqual([
      expect.stringMatching(
        /^packages\/keiko-server\/src\/coding-runtime\/codingRuntimeManager\.ts:\d+:\d+$/u,
      ),
    ]);
  });

  it("keeps every refusal word distinct across runs in one log", () => {
    REFUSALS.forEach(([code]) => {
      exitLineOf(`run-distinct-${String(code)}`, refusedWord(code) ?? "");
    });
    const seen = REFUSALS.map(([code]) =>
      exitLines(`run-distinct-${String(code)}`).map((line) => line.extra?.code),
    );
    expect(seen).toEqual(REFUSALS.map(([, word]) => [word]));
  });
});
