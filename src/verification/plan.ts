// Plan construction: turns a detected ScriptCatalog into an ordered VerificationPlan, and resolves
// targeted-test steps from a changed-file set. All path handling goes through the workspace
// boundary (resolveWithinWorkspace + WorkspaceFs.exists); no raw node:fs. Candidate test-path
// derivation uses plain string ops (no regex), so there is no ReDoS surface.

import { basename, dirname, extname, join } from "node:path";
import {
  nodeWorkspaceFs,
  resolveWithinWorkspace,
  type WorkspaceFs,
  type WorkspaceInfo,
} from "../workspace/index.js";
import {
  DEFAULT_VERIFICATION_LIMITS,
  type ScriptCatalog,
  type VerificationKind,
  type VerificationPlan,
  type VerificationResourceLimits,
  type VerificationStep,
} from "./types.js";

// The script-backed kinds, in run order. `targeted-test` is synthesised, not script-backed.
const SCRIPT_KINDS: readonly Exclude<VerificationKind, "targeted-test">[] = [
  "typecheck",
  "lint",
  "test",
  "build",
];

export interface PlanOptions {
  // Which kinds to include; defaults to all script-backed kinds.
  readonly only?: readonly VerificationKind[] | undefined;
  // Per-step resource-limit overrides merged over DEFAULT_VERIFICATION_LIMITS.
  readonly limits?: Partial<VerificationResourceLimits> | undefined;
  // Changed source files (workspace-relative) used to derive targeted-test steps.
  readonly changedFiles?: readonly string[] | undefined;
}

function resolveLimits(overrides: PlanOptions["limits"]): VerificationResourceLimits {
  return { ...DEFAULT_VERIFICATION_LIMITS, ...overrides };
}

function scriptStep(
  kind: Exclude<VerificationKind, "targeted-test">,
  scriptName: string | undefined,
  limits: VerificationResourceLimits,
): VerificationStep {
  if (scriptName === undefined) {
    return {
      kind,
      scriptName: undefined,
      command: "npm",
      args: ["run", kind],
      limits,
      skipReason: `no ${kind} script detected in package.json`,
    };
  }
  // `npm test` has a dedicated subcommand; every other kind runs via `npm run <script>`.
  const args = scriptName === "test" ? ["test"] : ["run", scriptName];
  return { kind, scriptName, command: "npm", args, limits };
}

function wants(only: PlanOptions["only"], kind: VerificationKind): boolean {
  return only === undefined || only.includes(kind);
}

// Derives candidate test paths for a changed source file: a sibling `X.test.ts`/`X.spec.ts`
// (and .tsx/.js/.jsx variants), and the same basename mirrored under each configured testDir.
function candidateTestPaths(workspace: WorkspaceInfo, file: string): readonly string[] {
  const ext = extname(file);
  if (ext === "") {
    return [];
  }
  const dir = dirname(file);
  const stem = basename(file, ext);
  const suffixes = [".test", ".spec"];
  const siblings = suffixes.map((s) => join(dir, `${stem}${s}${ext}`));
  const mirrored = workspace.testDirs.flatMap((testDir) =>
    suffixes.map((s) => join(testDir, `${stem}${s}${ext}`)),
  );
  return [...siblings, ...mirrored];
}

function existsInWorkspace(workspace: WorkspaceInfo, fs: WorkspaceFs, relPath: string): boolean {
  try {
    const abs = resolveWithinWorkspace(workspace.root, relPath);
    return fs.exists(abs);
  } catch {
    // A path that escapes the workspace is simply not a resolvable target; skip it.
    return false;
  }
}

interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
}

// Builds the framework-appropriate invocation that runs ONLY the given test files. vitest and jest
// both accept positional file paths. Returns undefined for an unknown framework, so no targeted
// step is added rather than guessing. The `npx <runner> ...` shape passes the #6 allowlist.
function targetedInvocation(
  workspace: WorkspaceInfo,
  files: readonly string[],
): Invocation | undefined {
  if (workspace.testFramework === "vitest") {
    return { command: "npx", args: ["vitest", "run", ...files] };
  }
  if (workspace.testFramework === "jest") {
    return { command: "npx", args: ["jest", ...files] };
  }
  return undefined;
}

export function resolveTargetedTests(
  workspace: WorkspaceInfo,
  changedFiles: readonly string[],
  fs: WorkspaceFs = nodeWorkspaceFs,
  limits: VerificationResourceLimits = DEFAULT_VERIFICATION_LIMITS,
): readonly VerificationStep[] {
  const resolved: string[] = [];
  for (const file of changedFiles) {
    for (const candidate of candidateTestPaths(workspace, file)) {
      if (existsInWorkspace(workspace, fs, candidate) && !resolved.includes(candidate)) {
        resolved.push(candidate);
      }
    }
  }
  if (resolved.length === 0) {
    return [];
  }
  const invocation = targetedInvocation(workspace, resolved);
  if (invocation === undefined) {
    return [];
  }
  return [
    {
      kind: "targeted-test",
      scriptName: undefined,
      command: invocation.command,
      args: invocation.args,
      limits,
    },
  ];
}

export function buildVerificationPlan(
  workspace: WorkspaceInfo,
  catalog: ScriptCatalog,
  options: PlanOptions = {},
  fs: WorkspaceFs = nodeWorkspaceFs,
): VerificationPlan {
  const limits = resolveLimits(options.limits);
  const steps: VerificationStep[] = [];
  for (const kind of SCRIPT_KINDS) {
    if (wants(options.only, kind)) {
      steps.push(scriptStep(kind, catalog.mapping[kind], limits));
    }
  }
  if (wants(options.only, "targeted-test") && options.changedFiles !== undefined) {
    steps.push(...resolveTargetedTests(workspace, options.changedFiles, fs, limits));
  }
  return { workspaceRoot: workspace.root, steps };
}
