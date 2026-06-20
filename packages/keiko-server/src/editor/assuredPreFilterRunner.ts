// Production assembly of the assured pre-filter (Issue #1202 wave-2; ADR-0043).
//
// Wires the disposable-execution composition to real effects: a throwaway copy of the target project,
// a sandboxed command runner (keiko-tools `runCommand` with `network: "none"` — the enforced egress
// boundary), JSON report reads, and guaranteed cleanup. Enforcement is decided by keiko-sandbox; on a
// host with no enforcing backend the pre-filter fails closed (the candidate is untrusted evidence
// only, never `assured`). The TS/JS gate toolchain (tsc + vitest + Stryker) is the first stack the
// Review Addendum scopes; the project-specific isolated-execution harness it composes is the shared
// path #1204/#1206 generalise.
//
// The command/coverage-key builders are pure and unit-tested; the filesystem copy and sandboxed spawn
// are thin node effects exercised when the feature is enabled on a host with a sandbox backend.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_SANDBOX_POLICY,
  type CommandRule,
  type EditorTestGenerationWirePatch,
  type EditorTestGenerationWireRequest,
  type EditorTestGenerationWireTarget,
} from "@oscharko-dev/keiko-contracts";
import { runCommand } from "@oscharko-dev/keiko-tools";
import { nodeSpawnFn } from "@oscharko-dev/keiko-tools/internal/exec";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { AssuredPreFilterOutcome } from "./assuredPreFilter.js";
import type { SandboxedCommand, SandboxedRunResult } from "./assuredGateRunner.js";
import {
  runDisposableAssuredPreFilter,
  sandboxEnforcesEgress,
  type DisposableExecutionPorts,
} from "./disposableAssuredExecution.js";

// The verification toolchain the gate runner executes for a candidate. The vitest toolchain (tsc +
// vitest + Stryker) is the #1202 default; the playwright toolchain (Issue #1203) verifies a browser
// smoke (tsc + `playwright test`). A browser smoke has no vitest coverage/mutation oracle, so its
// coverage/mutation gates produce no report and the candidate stays `unverified` (never `assured`),
// consistent with the owner decision that frontend tests are not labelled assured without those gates.
export type AssuredVerificationKind = "vitest" | "playwright";

export interface AssuredPreFilterArgs {
  readonly patch: EditorTestGenerationWirePatch;
  readonly request: EditorTestGenerationWireRequest;
  readonly realRoot: string;
  readonly signal: AbortSignal;
  // The toolchain to verify under; defaults to "vitest" (the #1202 behaviour) when absent.
  readonly verification?: AssuredVerificationKind | undefined;
}

export type AssuredPreFilterPort = (args: AssuredPreFilterArgs) => Promise<AssuredPreFilterOutcome>;

const ASSURED_DIR = ".keiko-assured";
const BASELINE_SUMMARY = `${ASSURED_DIR}/baseline/coverage-summary.json`;
const PATCHED_SUMMARY = `${ASSURED_DIR}/patched/coverage-summary.json`;
const MUTATION_REPORT = `${ASSURED_DIR}/mutation/mutation.json`;

// Command rules for the assured toolchain: only the deterministic node test toolchain, no network tools.
const ASSURED_COMMAND_RULES: readonly CommandRule[] = Object.freeze([
  { executable: "npx", denyFlags: Object.freeze(["-c", "--call"]) },
  { executable: "node" },
]);

function npx(args: readonly string[]): SandboxedCommand {
  return { command: "npx", args };
}

// ─── Pure builders (unit-tested) ─────────────────────────────────────────────────────────────────

// The source file under test, relative to the project root, used as the coverage key whose covered
// lines must strictly increase.
export function targetSourceRelPath(target: EditorTestGenerationWireTarget): string {
  return target.kind === "changed-file-set"
    ? (target.documents[0]?.path ?? "")
    : target.document.path;
}

interface GateCommands {
  readonly build: SandboxedCommand;
  readonly test: SandboxedCommand;
  readonly baseline: SandboxedCommand;
  readonly coverage: SandboxedCommand;
  readonly mutation: SandboxedCommand;
}

// The vitest gate commands (the #1202 default), all writing JSON reports under ASSURED_DIR so they can
// be read back deterministically. Baseline coverage runs the existing suite before the candidate is
// applied; the patched coverage run includes the candidate.
function vitestGateCommands(): GateCommands {
  return {
    build: npx(["tsc", "--noEmit"]),
    test: npx(["vitest", "run"]),
    baseline: npx([
      "vitest",
      "run",
      "--coverage",
      "--coverage.reporter=json-summary",
      `--coverage.reportsDirectory=${ASSURED_DIR}/baseline`,
    ]),
    coverage: npx([
      "vitest",
      "run",
      "--coverage",
      "--coverage.reporter=json-summary",
      `--coverage.reportsDirectory=${ASSURED_DIR}/patched`,
    ]),
    mutation: npx(["stryker", "run"]),
  };
}

// The Playwright gate commands (Issue #1203 browser-smoke). The candidate is type-checked and executed
// as a Playwright suite; there is no vitest coverage/mutation oracle for an end-to-end smoke, so the
// coverage/baseline/mutation slots run the same suite and emit no JSON report — those gates therefore
// cannot pass and the candidate stays `unverified`, never `assured`.
function playwrightGateCommands(): GateCommands {
  const run = npx(["playwright", "test"]);
  return {
    build: npx(["tsc", "--noEmit"]),
    test: run,
    baseline: run,
    coverage: run,
    mutation: run,
  };
}

// Selects the gate commands for the verification toolchain. Defaults to vitest, so callers that do not
// pass a kind keep the exact #1202 command set.
export function planGateCommands(kind: AssuredVerificationKind = "vitest"): GateCommands {
  return kind === "playwright" ? playwrightGateCommands() : vitestGateCommands();
}

// Normalises a vitest coverage summary's absolute file keys to project-relative paths so the covered
// delta matches the relative target key regardless of where the disposable root lives.
export function relativizeCoverageSummary(summary: unknown, root: string): unknown {
  if (typeof summary !== "object" || summary === null) {
    return summary;
  }
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(summary as Record<string, unknown>)) {
    out[key.startsWith(prefix) ? key.slice(prefix.length) : key] = value;
  }
  return out;
}

// Concatenates a candidate file's edit text. The generated candidate is a new (or rewritten) test
// file, so the edits' newText is its content; deleted files contribute nothing.
export function candidateFileText(edits: readonly { readonly newText: string }[]): string {
  return edits.map((edit) => edit.newText).join("");
}

// ─── Node effects ────────────────────────────────────────────────────────────────────────────────

function disposableWorkspace(root: string): WorkspaceInfo {
  return {
    root,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

// Runs one untrusted command in the disposable root through the enforced sandbox (network:"none").
async function runSandboxed(
  root: string,
  cmd: SandboxedCommand,
  signal: AbortSignal,
): Promise<SandboxedRunResult> {
  const result = await runCommand(
    { command: cmd.command, args: cmd.args, cwd: undefined, timeoutMs: undefined, signal },
    {
      workspace: disposableWorkspace(root),
      policy: { ...DEFAULT_SANDBOX_POLICY, network: "none" },
      commandRules: ASSURED_COMMAND_RULES,
      spawn: nodeSpawnFn,
      processEnv: process.env,
      now: () => Date.now(),
    },
  );
  return { exitCode: result.exitCode };
}

function readJsonReport(root: string, relativePath: string): unknown {
  try {
    return JSON.parse(readFileSync(join(root, relativePath), "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function isExcludedFromCopy(src: string): boolean {
  return src.includes("node_modules") || src.includes(".git") || src.includes(ASSURED_DIR);
}

function applyCandidateInto(root: string, patch: EditorTestGenerationWirePatch): void {
  for (const file of patch.files) {
    if (file.changeKind === "deleted") {
      continue;
    }
    const absolute = join(root, file.path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, candidateFileText(file.edits), "utf8");
  }
}

function nodePorts(args: AssuredPreFilterArgs, enforced: boolean): DisposableExecutionPorts {
  const cmds = planGateCommands(args.verification);
  return {
    enforced,
    makeRoot: (): Promise<string> => {
      const root = mkdtempSync(join(tmpdir(), "keiko-assured-"));
      cpSync(args.realRoot, root, { recursive: true, filter: (src) => !isExcludedFromCopy(src) });
      return Promise.resolve(root);
    },
    measureBaseline: (root): Promise<void> =>
      runSandboxed(root, cmds.baseline, args.signal).then(() => undefined),
    applyCandidate: (root): Promise<void> => {
      applyCandidateInto(root, args.patch);
      return Promise.resolve();
    },
    run: (root, cmd): Promise<SandboxedRunResult> => runSandboxed(root, cmd, args.signal),
    readReport: (root, relativePath): unknown =>
      relativePath === BASELINE_SUMMARY || relativePath === PATCHED_SUMMARY
        ? relativizeCoverageSummary(readJsonReport(root, relativePath), root)
        : readJsonReport(root, relativePath),
    dispose: (root): Promise<void> => {
      rmSync(root, { recursive: true, force: true });
      return Promise.resolve();
    },
    buildCommand: cmds.build,
    testCommand: cmds.test,
    coverageCommand: cmds.coverage,
    mutationCommand: cmds.mutation,
    baselineCoverageReportPath: BASELINE_SUMMARY,
    patchedCoverageReportPath: PATCHED_SUMMARY,
    mutationReportPath: MUTATION_REPORT,
    targetCoverageKeys: [targetSourceRelPath(args.request.target)],
  };
}

// The route's default pre-filter: decide enforcement, then run the assured funnel against a disposable
// execution root (or fail closed when egress cannot be enforced on this host).
export const defaultAssuredPreFilter: AssuredPreFilterPort = (args) =>
  runDisposableAssuredPreFilter(nodePorts(args, sandboxEnforcesEgress(args.realRoot)));
