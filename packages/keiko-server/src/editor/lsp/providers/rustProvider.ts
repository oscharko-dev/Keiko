import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { parse as parseToml } from "smol-toml";

import type {
  LanguageServiceOperation,
  ManagedLspRustConfiguration,
  ManagedLspRustCfg,
} from "@oscharko-dev/keiko-contracts";
import type { BackendAvailability } from "@oscharko-dev/keiko-sandbox";
import { currentPlatform, planIsolatedRun, probeBackends } from "@oscharko-dev/keiko-sandbox";

import type { HostLanguageProviderSpec } from "../hostLanguageProviders.js";
import { resolveExecutableOutsideWorkspace } from "../lspNodeAdapter.js";
import type { LspSpawnPreparation, LspSpawnPreparationInput } from "../lspProcessManager.js";

const RUST_OPERATIONS: readonly LanguageServiceOperation[] = Object.freeze([
  "diagnostics",
  "completion",
  "hover",
  "symbols",
  "formatting",
  "definition",
  "typeDefinition",
  "implementation",
  "references",
  "callHierarchy",
  "inlayHints",
  "renamePrepare",
  "renameApply",
  "codeActions",
  "signatureHelp",
] as const satisfies readonly LanguageServiceOperation[]);

const RUST_ENV_ALLOWLIST = Object.freeze(["LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP"]);
const RUST_DESCENDANTS = Object.freeze(["cargo", "rustc", "rustfmt"]);
const MAX_SCANNED_FILES = 100_000;
const MAX_MANIFEST_BYTES = 1_048_576;
const FORBIDDEN_NAMES = new Set([
  ".cargo",
  "build.rs",
  "rust-project.json",
  "rust-toolchain",
  "rust-toolchain.toml",
]);

export const RUST_OFFLINE_ENV = Object.freeze({
  CARGO_INCREMENTAL: "0",
  CARGO_NET_OFFLINE: "true",
  RA_LOG: "error",
  RUST_BACKTRACE: "0",
  RUSTUP_AUTO_INSTALL: "0",
});

export const RUST_PROVIDER_SPEC: HostLanguageProviderSpec = Object.freeze({
  id: "rust-lsp",
  label: "rust-analyzer",
  languages: Object.freeze(["rust"]),
  operations: RUST_OPERATIONS,
  executableName: "rust-analyzer",
  executableArgs: Object.freeze([]),
  requiredExecutables: Object.freeze(["cargo", "rust-analyzer", "rustc", "rustfmt"]),
  envAllowlist: RUST_ENV_ALLOWLIST,
  fixedEnv: RUST_OFFLINE_ENV,
  approvedDescendantExecutables: RUST_DESCENDANTS,
  envFlag: "KEIKO_EDITOR_LSP_RUST",
  semanticTokensCandidate: true,
  networkPolicy: "none",
  prepareSpawn: prepareRustSpawn,
});

export interface RustProtocolConfiguration {
  readonly settings: Readonly<Record<string, unknown>>;
  readonly initializationOptions: Readonly<Record<string, unknown>>;
  readonly resourceBudget: RustProviderResourceBudget;
}

export interface RustProviderResourceBudget {
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxMemoryMb?: number | undefined;
  readonly indexDeadlineMs?: number | undefined;
}

export function rustProtocolConfiguration(
  configuration: ManagedLspRustConfiguration,
): RustProtocolConfiguration {
  const safe = rustAnalyzerSettings(configuration);
  return {
    settings: { "rust-analyzer": safe },
    initializationOptions: safe,
    resourceBudget: {
      maxFiles: configuration.settings.resourceBudget.maxProjectFiles,
      maxBytes: configuration.settings.resourceBudget.maxCargoMetadataBytes,
      maxMemoryMb: configuration.settings.resourceBudget.maxMemoryMb,
      indexDeadlineMs: configuration.settings.resourceBudget.indexDeadlineMs,
    },
  };
}

function rustAnalyzerSettings(
  configuration: ManagedLspRustConfiguration,
): Readonly<Record<string, unknown>> {
  const settings = configuration.settings;
  return {
    cachePriming: {
      enable: false,
      numThreads: boundedThreadCount(settings.resourceBudget.maxMemoryMb),
    },
    cargo: {
      allTargets: false,
      autoreload: false,
      buildScripts: { enable: false, rebuildOnSave: false, useRustcWrapper: false },
      cfgs: settings.cfgs.map(formatCfg),
      features: [...settings.features],
      metadataExtraArgs: settings.cargoMetadata === "offline" ? ["--offline"] : [],
      noDefaultFeatures: settings.noDefaultFeatures,
      noDeps: true,
      sysroot: settings.sysrootPolicy === "approvedToolchain" ? "discover" : null,
      target: settings.target,
    },
    checkOnSave: false,
    files: { watcher: "client" },
    hover: { actions: { debug: { enable: false }, enable: false, run: { enable: false } } },
    lens: { debug: { enable: false }, enable: false, run: { enable: false } },
    linkedProjects:
      settings.cargoMetadata === "offline" ? settings.linkedProjects.map(({ path }) => path) : [],
    lru: { capacity: boundedLruCapacity(settings.resourceBudget.maxMemoryMb) },
    numThreads: boundedThreadCount(settings.resourceBudget.maxMemoryMb),
    procMacro: { attributes: { enable: false }, enable: false },
  };
}

function boundedThreadCount(maxMemoryMb: number): number {
  return Math.max(1, Math.min(8, Math.floor(maxMemoryMb / 512)));
}

function boundedLruCapacity(maxMemoryMb: number): number {
  return Math.max(32, Math.min(512, Math.floor(maxMemoryMb / 8)));
}

function formatCfg(cfg: ManagedLspRustCfg): string {
  return cfg.value === null ? cfg.key : `${cfg.key}="${cfg.value}"`;
}

interface RustMetadataScan {
  readonly unsafe: boolean;
  readonly files: number;
  readonly bytes: number;
}

function scanRustMetadata(root: string): RustMetadataScan {
  const pending = [root];
  let files = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      files += 1;
      const path = join(directory, entry.name);
      if (unsafeRustEntry(entry.name, path, entry.isSymbolicLink(), files)) {
        return { unsafe: true, files, bytes };
      }
      if (entry.isDirectory()) pending.push(path);
      if (entry.isFile()) bytes += statSync(path).size;
    }
  }
  return { unsafe: false, files, bytes };
}

function unsafeRustEntry(
  name: string,
  path: string,
  symbolicLink: boolean,
  files: number,
): boolean {
  if (files > MAX_SCANNED_FILES || FORBIDDEN_NAMES.has(name) || symbolicLink) return true;
  return name === "Cargo.toml" && unsafeManifest(path);
}

function unsafeManifest(path: string): boolean {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return true;
  try {
    return unsafeCargoTable(parseToml(readFileSync(path, "utf8")));
  } catch {
    return true;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unsafeCargoTable(manifest: Readonly<Record<string, unknown>>): boolean {
  const packageTable = isRecord(manifest.package) ? manifest.package : {};
  const libraryTable = isRecord(manifest.lib) ? manifest.lib : {};
  if (packageTable.build !== undefined && packageTable.build !== false) return true;
  if (libraryTable["proc-macro"] === true) return true;
  return containsEscapingCargoPath(manifest);
}

function containsEscapingCargoPath(root: Readonly<Record<string, unknown>>): boolean {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      for (const child of value as readonly unknown[]) pending.push(child);
      continue;
    }
    if (!isRecord(value)) continue;
    if (recordHasEscapingCargoPath(value)) return true;
    pending.push(...Object.values(value));
  }
  return false;
}

function recordHasEscapingCargoPath(value: Readonly<Record<string, unknown>>): boolean {
  const path = value.path;
  return typeof path === "string" && escapingCargoPath(path);
}

function escapingCargoPath(value: string): boolean {
  return isAbsolute(value) || value.split(/[\\/]/u).includes("..");
}

function nativeBackends(input: LspSpawnPreparationInput): ReturnType<typeof probeBackends> {
  const probed = probeBackends(input.processEnv, currentPlatform());
  return { ...probed, docker: false, podman: false };
}

export interface RustSpawnSecurityDeps {
  readonly availability?: BackendAvailability | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly resolveExecutable?: typeof resolveExecutableOutsideWorkspace | undefined;
  readonly usesRustupShims?: ((input: LspSpawnPreparationInput) => boolean) | undefined;
}

function withinResourceBudget(scan: RustMetadataScan, budget: RustProviderResourceBudget): boolean {
  return !scan.unsafe && scan.files <= budget.maxFiles && scan.bytes <= budget.maxBytes;
}

export function prepareRustSpawn(
  input: LspSpawnPreparationInput,
  securityDeps: RustSpawnSecurityDeps = {},
): LspSpawnPreparation {
  const initialScan = scanRustMetadata(input.workspace.root);
  const budget = input.resourceBudget;
  assertRustWorkspaceSafe(input.workspace.root, initialScan, budget);
  if ((securityDeps.usesRustupShims ?? usesRustupShims)(input)) {
    throw new Error("Rust safe mode requires a standalone approved toolchain");
  }
  const runtime = createRustRuntimeState();
  try {
    assertCombinedBudget(input.workspace.root, runtime.root, budget);
    const decision = isolatedRustCommand(input, securityDeps);
    const executable = resolveSandboxExecutable(input, securityDeps, decision.command);
    return preparedRustSpawn(input, decision.args, executable, budget, runtime);
  } catch (error) {
    runtime.cleanup();
    throw error;
  }
}

function assertRustWorkspaceSafe(
  root: string,
  scan: RustMetadataScan,
  budget: RustProviderResourceBudget | undefined,
): void {
  const exceeded = budget !== undefined && !withinResourceBudget(scan, budget);
  if (!lstatSync(root).isDirectory() || scan.unsafe || exceeded) {
    throw new Error("Rust safe mode rejects executable or escaping project metadata");
  }
}

function isolatedRustCommand(
  input: LspSpawnPreparationInput,
  securityDeps: RustSpawnSecurityDeps,
): { readonly command: string; readonly args: readonly string[] } {
  const platform = securityDeps.platform ?? currentPlatform();
  const decision = planIsolatedRun(
    { command: input.executable, args: input.args, cwd: input.workspace.root, network: "none" },
    securityDeps.availability ?? nativeBackends(input),
    platform,
  );
  if (decision.kind !== "wrapped" || !decision.attestation.networkEnforced) {
    throw new Error("Rust LSP egress isolation unavailable");
  }
  return decision;
}

function resolveSandboxExecutable(
  input: LspSpawnPreparationInput,
  securityDeps: RustSpawnSecurityDeps,
  command: string,
): string {
  return (securityDeps.resolveExecutable ?? resolveExecutableOutsideWorkspace)(
    command,
    input.workspace,
    input.processEnv,
  );
}

function preparedRustSpawn(
  input: LspSpawnPreparationInput,
  args: readonly string[],
  executable: string,
  budget: RustProviderResourceBudget | undefined,
  runtime: RustRuntimeState,
): LspSpawnPreparation {
  return {
    executable,
    args,
    env: { ...input.env, ...runtime.environment },
    cleanup: runtime.cleanup,
    ...(budget === undefined
      ? {}
      : {
          resourceBudgetSatisfied: (): boolean =>
            combinedBudgetSatisfied(input.workspace.root, runtime.root, budget),
          backgroundResourceBudgetSatisfied: (): boolean =>
            withinResourceBudget(runtimeUsage(runtime.root), budget),
        }),
  };
}

interface RustRuntimeState {
  readonly root: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly cleanup: () => void;
}

function createRustRuntimeState(): RustRuntimeState {
  const root = mkdtempSync(join(tmpdir(), "keiko-rust-lsp-"));
  chmodSync(root, 0o700);
  const cargoHome = privateDirectory(root, "cargo-home");
  const rustupHome = privateDirectory(root, "rustup-home");
  const cache = privateDirectory(root, "cache");
  const target = privateDirectory(root, "target");
  const temporary = privateDirectory(root, "tmp");
  return {
    root,
    environment: {
      CARGO_HOME: cargoHome,
      RUSTUP_HOME: rustupHome,
      CARGO_TARGET_DIR: target,
      XDG_CACHE_HOME: cache,
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
    },
    cleanup: (): void => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function privateDirectory(root: string, name: string): string {
  const path = join(root, name);
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function usesRustupShims(input: LspSpawnPreparationInput): boolean {
  const rustup = optionalExecutable("rustup", input.workspace, input.processEnv);
  if (rustup === undefined) return false;
  return RUST_DESCENDANTS.some((name) => descendantMatchesRustup(name, rustup, input));
}

function optionalExecutable(
  name: string,
  workspace: LspSpawnPreparationInput["workspace"],
  processEnv: NodeJS.ProcessEnv,
): string | undefined {
  try {
    return resolveExecutableOutsideWorkspace(name, workspace, processEnv);
  } catch {
    return undefined;
  }
}

function descendantMatchesRustup(
  name: string,
  rustup: string,
  input: LspSpawnPreparationInput,
): boolean {
  try {
    const descendant = resolveExecutableOutsideWorkspace(name, input.workspace, {
      PATH: input.env.PATH,
    });
    const left = statSync(realpathSync(descendant));
    const right = statSync(realpathSync(rustup));
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return true;
  }
}

function runtimeUsage(root: string): RustMetadataScan {
  const pending = [root];
  let files = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) return { unsafe: true, files, bytes };
      if (entry.isDirectory()) pending.push(path);
      if (entry.isFile()) {
        files += 1;
        bytes += statSync(path).size;
      }
    }
  }
  return { unsafe: false, files, bytes };
}

function combinedBudgetSatisfied(
  workspaceRoot: string,
  runtimeRoot: string,
  budget: RustProviderResourceBudget,
): boolean {
  const workspace = scanRustMetadata(workspaceRoot);
  const runtime = runtimeUsage(runtimeRoot);
  return (
    !workspace.unsafe &&
    !runtime.unsafe &&
    workspace.files + runtime.files <= budget.maxFiles &&
    workspace.bytes + runtime.bytes <= budget.maxBytes
  );
}

function assertCombinedBudget(
  workspaceRoot: string,
  runtimeRoot: string,
  budget: RustProviderResourceBudget | undefined,
): void {
  if (budget !== undefined && !combinedBudgetSatisfied(workspaceRoot, runtimeRoot, budget)) {
    throw new Error("Rust runtime resource budget exceeded");
  }
}
