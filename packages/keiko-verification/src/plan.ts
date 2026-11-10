// Plan construction: turns a detected ScriptCatalog into an ordered VerificationPlan, and resolves
// targeted-test steps from a changed-file set. All path handling goes through the workspace
// boundary (resolveWithinWorkspace + WorkspaceFs.exists); no raw node:fs. Candidate test-path
// derivation uses plain string ops (no regex), so there is no ReDoS surface.

import { posix, sep } from "node:path";
import {
  assertContainedRealPath,
  resolveWithinWorkspace,
  type WorkspaceFs,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import type { VerificationPackage } from "./package-dir.js";
import { targetedVitestProjects } from "./targeted-project.js";
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
  // The nested package the script steps run in; absent, they run at the workspace root with npm.
  readonly package?: VerificationPackage | undefined;
}

function resolveLimits(overrides: PlanOptions["limits"]): VerificationResourceLimits {
  return { ...DEFAULT_VERIFICATION_LIMITS, ...overrides };
}

// What a step that cannot run for want of an installed tree says. The governed verifier installs
// dependencies with npm only, so a Yarn or pnpm package without its own tree has to be verified in
// the caller's shell; the closed prefix is what the tool maps to `native-shell-required`.
export const NATIVE_SHELL_SKIP_PREFIX = "native shell required: ";

function nativeShellSkipReason(pkg: VerificationPackage | undefined): string | undefined {
  return pkg === undefined || pkg.manager === "npm" || pkg.installed
    ? undefined
    : `${NATIVE_SHELL_SKIP_PREFIX}${pkg.manager} dependencies are not installed`;
}

function scriptStep(
  kind: Exclude<VerificationKind, "targeted-test">,
  scriptName: string | undefined,
  limits: VerificationResourceLimits,
  pkg: VerificationPackage | undefined,
): VerificationStep {
  const command = pkg?.manager ?? "npm";
  const cwd = pkg === undefined ? {} : { cwd: pkg.dir };
  if (scriptName === undefined) {
    return {
      kind,
      scriptName: undefined,
      command,
      args: ["run", kind],
      limits,
      skipReason: `no ${kind} script detected in package.json`,
      ...cwd,
    };
  }
  // `npm test` has a dedicated subcommand; every other kind (and every Yarn or pnpm script) runs via
  // `<manager> run <script>`.
  const args = scriptName === "test" && command === "npm" ? ["test"] : ["run", scriptName];
  const skipReason = nativeShellSkipReason(pkg);
  return {
    kind,
    scriptName,
    command,
    args,
    limits,
    ...(skipReason === undefined ? {} : { skipReason }),
    ...cwd,
  };
}

function wants(only: PlanOptions["only"], kind: VerificationKind): boolean {
  return only === undefined || only.includes(kind);
}

// A planned test path is an argument of the verification command, which runs in a Linux container
// (ADR-0043 D20). Vitest turns a backslash into a separator only when it runs on Windows itself, and
// Jest reads the argument as a regular expression, so a path built with Windows separators selects no
// test there. Planned paths therefore always use POSIX separators, whatever the host.
function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

// Derives candidate test paths for a changed source file: a sibling `X.test.ts`/`X.spec.ts`
// (and .tsx/.js/.jsx variants), and the same basename mirrored under each configured testDir.
function candidateTestPaths(workspace: WorkspaceInfo, changedFile: string): readonly string[] {
  const file = toPosix(changedFile);
  const ext = posix.extname(file);
  if (ext === "") {
    return [];
  }
  const dir = posix.dirname(file);
  const stem = posix.basename(file, ext);
  const suffixes = [".test", ".spec"];
  const siblings = suffixes.map((s) => posix.join(dir, `${stem}${s}${ext}`));
  const sourceSubdir = sourceRelativeDir(workspace, file);
  const mirrored = workspace.testDirs.flatMap((testDir) =>
    suffixes.map((s) => posix.join(toPosix(testDir), sourceSubdir, `${stem}${s}${ext}`)),
  );
  return [...siblings, ...mirrored];
}

function sourceRelativeDir(workspace: WorkspaceInfo, file: string): string {
  const dir = posix.dirname(file);
  for (const sourceDir of workspace.sourceDirs) {
    const rel = posix.relative(toPosix(sourceDir), dir);
    if (rel === "") {
      return "";
    }
    if (!rel.startsWith("..") && !rel.startsWith("/") && !rel.includes(":")) {
      return rel;
    }
  }
  return dir === "." ? "" : dir;
}

function existsInWorkspace(workspace: WorkspaceInfo, fs: WorkspaceFs, relPath: string): boolean {
  try {
    const abs = resolveWithinWorkspace(workspace.root, relPath);
    if (!fs.exists(abs)) return false;
    const path = assertContainedRealPath(fs, workspace.root, abs, "targeted test file");
    return fs.stat(path).isFile;
  } catch {
    // A path that escapes the workspace is simply not a resolvable target; skip it.
    return false;
  }
}

interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
}

// Builds the framework-appropriate invocation that runs ONLY the given test files. vitest, jest,
// and Node's native test runner accept positional file paths. Returns undefined for an unknown
// framework, so no targeted step is added rather than guessing.
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
  if (workspace.testFramework === "node-test") {
    return { command: "node", args: ["--test", ...files] };
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
  return planDirectTargetedTests(workspace, resolved, fs, limits);
}

function targetedSteps(
  workspace: WorkspaceInfo,
  files: readonly string[],
  fs: WorkspaceFs,
  limits: VerificationResourceLimits,
): readonly VerificationStep[] {
  if (workspace.testFramework === "vitest") {
    return targetedVitestProjects(workspace, files, fs).map((project) => ({
      kind: "targeted-test",
      scriptName: undefined,
      command: "npx",
      args: [
        "vitest",
        "run",
        ...(project.root === "" ? [] : ["--root", project.root]),
        ...project.files,
      ],
      limits,
    }));
  }
  const invocation = targetedInvocation(workspace, files);
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

// Builds a single targeted-test step that runs EXACTLY the given test files (Issue #1204 post-apply
// verification), rather than deriving sibling test paths from changed source files. Each path is
// validated to be a workspace-contained, existing file before it is included; an unknown test framework
// or an empty resolved set yields no step (the caller then reports verification as skipped/not-run).
// Used to re-confirm a just-applied generated test in place, isolated by the orchestrator's enforced
// network policy.
export function planDirectTargetedTests(
  workspace: WorkspaceInfo,
  testFiles: readonly string[],
  fs: WorkspaceFs = nodeWorkspaceFs,
  limits: VerificationResourceLimits = DEFAULT_VERIFICATION_LIMITS,
): readonly VerificationStep[] {
  const resolved: string[] = [];
  for (const file of testFiles.map(toPosix)) {
    if (existsInWorkspace(workspace, fs, file) && !resolved.includes(file)) {
      resolved.push(file);
    }
  }
  if (resolved.length === 0) {
    return [];
  }
  return targetedSteps(workspace, resolved, fs, limits);
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
      steps.push(scriptStep(kind, catalog.mapping[kind], limits, options.package));
    }
  }
  if (wants(options.only, "targeted-test") && options.changedFiles !== undefined) {
    steps.push(...resolveTargetedTests(workspace, options.changedFiles, fs, limits));
  }
  return {
    workspaceRoot: workspace.root,
    steps,
    ...(options.package === undefined
      ? {}
      : { packageDir: options.package.dir, packageManager: options.package.manager }),
  };
}

// Targeted tests of a nested package. The files are workspace-relative; the invocation is planned
// against the package folder (its own test framework, its own nested Vitest projects). Vitest runs
// from the workspace root with the package as its `--root`, so hoisted tools stay reachable inside
// the execution-root sandbox; Jest has no generated root form and runs in the package folder. A
// file outside the package is not planned.
export function planPackageTargetedTests(
  pkg: VerificationPackage,
  testFiles: readonly string[],
  fs: WorkspaceFs = nodeWorkspaceFs,
  limits: VerificationResourceLimits = DEFAULT_VERIFICATION_LIMITS,
): readonly VerificationStep[] {
  const prefix = `${pkg.dir}/`;
  const relative = testFiles
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => file.startsWith(prefix))
    .map((file) => file.slice(prefix.length));
  const skipReason = nativeShellSkipReason(pkg);
  return planDirectTargetedTests(pkg.workspace, relative, fs, limits).map((step) => ({
    ...packageInvocation(step, pkg.dir),
    ...(skipReason === undefined ? {} : { skipReason }),
  }));
}

function packageInvocation(step: VerificationStep, dir: string): VerificationStep {
  if (step.args[0] !== "vitest") return { ...step, cwd: dir };
  const hasRoot = step.args[2] === "--root";
  const nested = hasRoot ? (step.args[3] ?? "") : "";
  const files = step.args.slice(hasRoot ? 4 : 2);
  return { ...step, args: ["vitest", "run", "--root", posix.join(dir, nested), ...files] };
}
