// Runner support primitives (ADR-0012 D3/C5). Pure-ish, IO-narrow helpers the EvalRunner composes:
// fixture materialization to/from a temp dir, a recording WorkspaceWriter and recording event sink, a
// deterministic fake SpawnFn (ported from the tests/verification fake-child pattern), typed workflow
// input construction from a fixture's untyped workflowInput record, and the ScoringInput projection
// from a workflow report. Keeping these here keeps runner.ts focused on orchestration and under the
// LOC limit.

import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { SpawnFn, WorkspaceWriter } from "@oscharko-dev/keiko-tools";
import type { UnitTestTarget, UnitTestWorkflowInput } from "@oscharko-dev/keiko-workflows";
import type { BugInvestigationInput, BugReportInput } from "@oscharko-dev/keiko-workflows";
import type { ScoringInput } from "./scorer.js";
import type { EvaluationFixture, EvaluationMode } from "./types.js";

export interface MaterializedWorkspace {
  readonly root: string;
  readonly cleanup: () => void;
}

// Writes every workspaceFile to a fresh mkdtemp dir and returns the absolute root + a cleanup that
// removes the whole tree. POSIX-relative keys are joined onto the root; parent dirs are created.
// Containment guard: a key like `../../etc/x` would resolve outside the temp root — reject it
// loudly rather than letting a malformed fixture escape the sandbox (mirrors #5/#6 realpath ethos).
export function materializeFixture(fixture: EvaluationFixture): MaterializedWorkspace {
  const root = mkdtempSync(join(tmpdir(), "keiko-eval-"));
  for (const [relPath, content] of Object.entries(fixture.workspaceFiles)) {
    const abs = join(root, relPath);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new Error(
        `fixture workspaceFiles key "${relPath}" resolves outside the temp root: ${abs}`,
      );
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return {
    root,
    cleanup: (): void => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface RecordingWriter extends WorkspaceWriter {
  readonly writeCount: () => number;
}

// A WorkspaceWriter that records writes WITHOUT touching disk, so an unsafe-action fixture can assert
// zero writes and an apply fixture can confirm the apply phase attempted exactly the expected writes.
export function recordingWriter(): RecordingWriter {
  let writes = 0;
  const recordWrite = (): void => {
    writes += 1;
  };
  return {
    writeCount: (): number => writes,
    writeFileUtf8: recordWrite,
    mkdirp: recordWrite,
    remove: recordWrite,
    rename: recordWrite,
  };
}

export interface RecordingSink {
  readonly emit: (event: { readonly type: string }) => void;
  readonly events: () => readonly { readonly type: string }[];
}

// A workflow/bug event sink that buffers every emitted event so the runner can fold model-usage
// events into the evidence manifest. Structurally satisfies WorkflowEventSink / BugWorkflowEventSink.
export function recordingSink(): RecordingSink {
  const events: { type: string }[] = [];
  return {
    events: () => events,
    emit: (event): void => {
      events.push(event);
    },
  };
}

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
  kill: (signal?: NodeJS.Signals) => boolean;
}

// A deterministic fake SpawnFn (ported from tests/verification/_support.ts): every spawned command
// emits the scripted stdout then closes with the given exit code on the next microtask, so
// runVerification produces a deterministic VerificationAuditSummary offline with no real process.
export function fakeSpawn(exitCode: number, stdout = ""): SpawnFn {
  return (): ChildProcess => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4242;
    child.kill = (): boolean => true;
    queueMicrotask(() => {
      if (stdout.length > 0) {
        child.stdout.emit("data", Buffer.from(stdout, "utf8"));
      }
      child.emit("close", exitCode, null);
    });
    return child as unknown as ChildProcess;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Narrows the fixture's untyped `target` into a typed UnitTestTarget. Throws on an unknown shape so a
// malformed fixture fails loudly at the runner boundary rather than via a blind cast (quality bar).
function toUnitTestTarget(value: unknown): UnitTestTarget {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("fixture workflowInput.target must be an object with a string `kind`");
  }
  if (value.kind === "file" && typeof value.filePath === "string") {
    return typeof value.targetFunction === "string"
      ? { kind: "file", filePath: value.filePath, targetFunction: value.targetFunction }
      : { kind: "file", filePath: value.filePath };
  }
  if (value.kind === "module" && typeof value.moduleDir === "string") {
    return { kind: "module", moduleDir: value.moduleDir };
  }
  if (value.kind === "changedFiles" && Array.isArray(value.filePaths)) {
    return { kind: "changedFiles", filePaths: value.filePaths.map(String) };
  }
  throw new Error(`fixture workflowInput.target has an unsupported kind: ${value.kind}`);
}

export function buildUnitTestInput(
  fixture: EvaluationFixture,
  workspaceRoot: string,
  modelId: string,
): UnitTestWorkflowInput {
  return {
    workspaceRoot,
    target: toUnitTestTarget(fixture.workflowInput.target),
    apply: fixture.apply === true,
    modelId,
  };
}

function toBugReport(value: unknown): BugReportInput {
  if (!isRecord(value)) {
    throw new Error("fixture workflowInput.report must be an object");
  }
  const report: BugReportInput = {
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.failingOutput === "string" ? { failingOutput: value.failingOutput } : {}),
    ...(typeof value.stackTrace === "string" ? { stackTrace: value.stackTrace } : {}),
    ...(Array.isArray(value.targetFiles) ? { targetFiles: value.targetFiles.map(String) } : {}),
  };
  return report;
}

export function buildBugInput(
  fixture: EvaluationFixture,
  workspaceRoot: string,
  modelId: string,
): BugInvestigationInput {
  return {
    workspaceRoot,
    report: toBugReport(fixture.workflowInput.report),
    apply: fixture.apply === true,
    modelId,
  };
}

// Projects a workflow report (unit-tests or bug-investigation) + the recording writer's observed
// write count into the report-shape-agnostic ScoringInput the pure scorer consumes.
export function toScoringInput(
  report: Record<string, unknown>,
  writeCount: number,
  manifestValid: boolean,
  mode: EvaluationMode,
): ScoringInput {
  const proposedDiff = typeof report.proposedDiff === "string" ? report.proposedDiff : undefined;
  const verification = resolveVerification(report);
  const verificationStatus =
    verification !== undefined && typeof verification.overallStatus === "string"
      ? verification.overallStatus
      : undefined;
  return {
    status: typeof report.status === "string" ? report.status : "unknown",
    proposedDiff,
    changedFileCount: changedFileCount(report),
    patchBytes: proposedDiff === undefined ? 0 : Buffer.byteLength(proposedDiff, "utf8"),
    verificationStatus,
    verificationPresent: verification !== undefined,
    manifestValid,
    recordedWriteCount: writeCount,
    mode,
  };
}

function changedFileCount(report: Record<string, unknown>): number {
  if (Array.isArray(report.addedTestFiles)) {
    return report.addedTestFiles.length;
  }
  return Array.isArray(report.changedFiles) ? report.changedFiles.length : 0;
}

// The verification summary lives at `verificationSummary` on a unit-test report and at
// `verified.verification` on a bug-investigation report; this resolves whichever shape is present.
function resolveVerification(report: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(report.verificationSummary)) {
    return report.verificationSummary;
  }
  const verified = report.verified;
  if (isRecord(verified) && isRecord(verified.verification)) {
    return verified.verification;
  }
  return undefined;
}
