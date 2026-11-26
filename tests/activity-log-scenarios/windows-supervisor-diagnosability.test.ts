// #4495: the Windows supervisor boundary through the REAL Activity Log writer and the support
// analyzer. The refusal word on the `coding-runtime.exit` line, the reap proof's root exit code and
// the stale-profile sweep's counts must each survive the production file writer and appear,
// distinctly and as closed values, in the run's analyzer timeline (the body-free machine view
// `keiko support analyze` projects), with no message text, path or command line beside them.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";

import { defaultServerDiagnosticSink } from "../../packages/keiko-server/src/diagnostics-log.js";
import {
  NativeRuntimeTree,
  type NativeRuntimeHelperProcess,
} from "../../packages/keiko-server/src/coding-runtime/nativeRuntimeProcessTree.js";
import {
  recordWindowsStaleGrantsSwept,
  recordWindowsTreeReaped,
} from "../../packages/keiko-server/src/coding-runtime/runtimeGatewayProcessSandbox.js";
import {
  closeFileServerLogSinks,
  createFileServerLogSink,
} from "../../packages/keiko-server/src/observability/index.js";
import { readPersistedActivityLog } from "../support/activity-log-proof.js";
import { resetServerLogger } from "../support/activity-log-test-support.js";

// What a path, a message or a command line would look like if one rode along.
const LEAK_PATTERN = /[\\/]|[A-Z]:|\.exe|\s--|Access is denied|0x[0-9a-f]{8}/iu;

interface TimelineLine {
  readonly op?: string | undefined;
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

function launchPacket(words: readonly number[]): Buffer {
  const packet = Buffer.alloc(12 + 4 * words.length);
  packet.write("KRS1", 0, "ascii");
  packet.writeUInt16LE(1, 4);
  packet.writeUInt16LE(1, 6);
  packet.writeUInt32LE(4 * words.length, 8);
  words.forEach((word, index) => packet.writeUInt32LE(word, 12 + 4 * index));
  return packet;
}

function reapPacket(rootExitCode: number): Buffer {
  const packet = Buffer.alloc(20);
  packet.write("KRS1", 0, "ascii");
  packet.writeUInt16LE(1, 4);
  packet.writeUInt16LE(2, 6);
  packet.writeUInt32LE(8, 8);
  packet.writeUInt32LE(rootExitCode, 12);
  packet.writeUInt32LE(0, 16);
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

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-scenario-windows-supervisor-"));
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
    vi.stubEnv("KEIKO_LOG_LEVEL", "debug");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    resetServerLogger();
  });

  afterEach(() => {
    closeFileServerLogSinks();
    resetServerLogger();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function timelineOf(runId: string): readonly TimelineLine[] {
    const result = analyzeLogText(readPersistedActivityLog(stateDir));
    expect(result.evidence.classification).toBe("supported");
    const timeline = result.timelines.find((candidate) => candidate.correlationId === runId);
    if (timeline === undefined) throw new Error(`no timeline for ${runId}`);
    return timeline.lines;
  }

  function exitLineOf(runId: string, word: string): void {
    defaultServerDiagnosticSink.record({
      correlationId: runId,
      timestamp: new Date().toISOString(),
      operation: "coding-runtime.exit",
      source: "coding-runtime-manager.exit",
      errorClass: "RuntimeUnexpectedExit",
      message: "runtime-exit-code",
      code: word,
    });
  }

  // The manager writes the refusal word of the real tree on the exit line; here the tree is driven
  // with each supervisor refusal and the word it reports is written through the real writer.
  it.each([
    [18, "supervisor-no-desktop"],
    [19, "supervisor-image-path"],
    [8, "supervisor-grants-acl"],
    [14, "supervisor-relay-profile"],
    [3, "supervisor-process-create"],
  ])("projects refusal %i as %s on the run's timeline", (code, word) => {
    const { process: child, control } = helper();
    const tree = new NativeRuntimeTree("a".repeat(32), child, "win32");
    control.emit("data", refusalPacket(code));
    const reason = tree.failureReason();
    expect(reason).toBe(word);
    const runId = `run-refused-${String(code)}`;
    exitLineOf(runId, reason ?? "");

    const lines = timelineOf(runId).filter(
      (line) => line.extra?.diagnosticOperation === "coding-runtime.exit",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.extra?.code).toBe(word);
    expect(JSON.stringify(lines)).not.toMatch(LEAK_PATTERN);
  });

  it("keeps each refusal word distinct across runs in one log", () => {
    const words = [18, 19, 8, 14, 3].map((code) => {
      const { process: child, control } = helper();
      const tree = new NativeRuntimeTree("a".repeat(32), child, "win32");
      control.emit("data", refusalPacket(code));
      return tree.failureReason() ?? "";
    });
    words.forEach((word, index) => {
      exitLineOf(`run-distinct-${String(index)}`, word);
    });
    const seen = words.map((_, index) =>
      timelineOf(`run-distinct-${String(index)}`)
        .filter((line) => line.extra?.diagnosticOperation === "coding-runtime.exit")
        .map((line) => line.extra?.code),
    );
    expect(seen).toEqual(words.map((word) => [word]));
    expect(new Set(words).size).toBe(words.length);
  });

  it.each([0, 130, 0xc0000142])(
    "projects root exit code %i as a number on the timeline",
    (code) => {
      const sink = createFileServerLogSink(stateDir, { env: { KEIKO_LOG_LEVEL: "debug" } });
      const { process: child, control } = helper();
      const runId = `run-reaped-${String(code)}`;
      new NativeRuntimeTree("a".repeat(32), child, "win32", {
        reaped: (rootExitCode): void => {
          recordWindowsTreeReaped(sink, runId, rootExitCode);
        },
      });
      control.emit("data", launchPacket([0, 0, 0, 0]));
      control.emit("data", reapPacket(code));

      const lines = timelineOf(runId).filter(
        (line) => line.op === "runtime.confinement.tree-reaped",
      );
      expect(lines).toHaveLength(1);
      expect(lines[0]?.extra?.rootExitCode).toBe(code);
      expect(lines[0]?.extra?.backend).toBe("windows-appcontainer");
      expect(JSON.stringify(lines)).not.toMatch(/Access is denied|\.exe|[A-Z]:\\/u);
    },
  );

  // AC3, TypeScript half. A supervisor that crashed leaves its run's AppContainer profile; the next
  // launch's response states how many such profiles it removed or failed to remove, and that count
  // reaches the log through the real writer. That a living run's profile, another Keiko's profile
  // and any foreign profile are never touched is the native sweep's invariant, proven on the
  // Windows job by gateway_profiles.test.c (test_foreign_names, test_sweep): the response carries
  // only counts, so the host cannot restate it.
  it("records the sweep of a crashed supervisor's profile on the next launch, and nothing when none is stale", () => {
    const sink = createFileServerLogSink(stateDir, { env: { KEIKO_LOG_LEVEL: "debug" } });
    const launch = (runId: string, words: readonly number[]): void => {
      const { process: child, control } = helper();
      new NativeRuntimeTree("a".repeat(32), child, "win32", {
        launchSweep: (sweep): void => {
          recordWindowsStaleGrantsSwept(sink, runId, sweep);
        },
      });
      control.emit("data", launchPacket(words));
    };
    // Launch 1 follows a crash: one stale profile removed, one that could not be.
    launch("run-after-crash", [0, 0, 1, 1]);
    // Launch 2 finds only live and foreign profiles: nothing swept, nothing recorded.
    launch("run-after-clean", [0, 0, 0, 0]);

    const swept = timelineOf("run-after-crash").filter(
      (line) => line.op === "runtime.confinement.stale-grants-swept",
    );
    expect(swept).toHaveLength(1);
    expect(swept[0]?.extra).toMatchObject({
      removedProfileCount: 1,
      failedProfileCount: 1,
      removedEntryCount: 0,
      failedCount: 0,
    });
    expect(
      analyzeLogText(readPersistedActivityLog(stateDir)).timelines.some(
        (timeline) => timeline.correlationId === "run-after-clean",
      ),
    ).toBe(false);
  });
});
