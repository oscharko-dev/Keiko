// Runs the approved package scripts themselves, so the bytes that execute are the bytes that were
// approved. `npm run <name>` reads package.json again in a process of its own, after the exclusive
// workspace queue and the dependency bootstrap; a script edited in that interval would run under
// the earlier approval. Here the manifest is read ONCE, its script table is proven against the
// approved digest, and the very bytes of that read are handed to `/bin/sh -c` as positional
// arguments, in the order npm runs them. Nothing re-reads package.json afterwards.
//
// This is not a widening: `npm run` hands exactly these bytes to `sh -c` too. The one `sh` rule the
// step needs admits only the constant wrapper below as its program; the repository's bytes are
// never parsed by the wrapper, only passed on as arguments.

import { join } from "node:path";
import type { WorkspaceFs, WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { readPackageManifest, scriptTableDigest, type PackageManifest } from "./detect.js";
import type { VerificationStep } from "./types.js";

// The closed prefix of a denial because the approved script bytes cannot be run unbound.
export const SCRIPTS_UNBOUND_DENIAL_PREFIX = "scripts could not be bound to the approved bytes: ";

export type BoundScriptRefusal =
  | "script-shell-configured"
  | "ignore-scripts-configured"
  | "package-manager-configuration"
  | "lifecycle-order-unknown"
  | "package-config-unsupported"
  | "script-not-runnable"
  | "yarn-pnp-unsupported"
  | "approval-missing"
  | "windows-step-copy-missing";

// One plain sentence per closed reason, with the next step. The closed code stays the machine
// reading; this text is what the person (and the model that reports to them) reads.
export const BOUND_SCRIPT_REFUSAL_TEXT: Readonly<Record<BoundScriptRefusal, string>> =
  Object.freeze({
    "script-shell-configured":
      "This project sets a custom script shell, which Keiko does not reproduce; remove script-shell from the project's .npmrc or package.json config, or run the check in your own terminal.",
    "ignore-scripts-configured":
      "This project's ignore-scripts setting cannot be applied the way its package manager does; set it to true or false in the project's .npmrc, or run the check in your own terminal.",
    "package-manager-configuration":
      "This project's package manager configuration changes how scripts run and Keiko does not reproduce it; remove that setting or run the check in your own terminal.",
    "lifecycle-order-unknown":
      "Yarn and pnpm run a script's pre and post scripts depending on their version, so Keiko cannot tell the order; run the check in your own terminal.",
    "package-config-unsupported":
      "The config section of package.json holds values Keiko does not reproduce; use plain text, number or true/false values, or run the check in your own terminal.",
    "script-not-runnable":
      "The approved script cannot be started as written (it is empty of text, too large or contains a NUL character); shorten or fix the script in package.json.",
    "yarn-pnp-unsupported":
      "This project uses Plug'n'Play, which Keiko cannot run scripts for; run the check in your own terminal or link node_modules instead (nodeLinker: node-modules for Yarn, node-linker=hoisted for pnpm).",
    "approval-missing":
      "The scripts of this run carry no approval, so Keiko will not run them; start the check again.",
    "windows-step-copy-missing":
      "Keiko could not make the private copy of this project that Windows steps run in, so it will not run the scripts against the live folder; start the check again.",
  });

// The closed outcome of binding one script step to the approved bytes, as the activity log records
// it: `bound` (Keiko ran the approved bytes itself), `fenced-windows` (the package manager ran
// against the private step copy under the digest fence), `scripts-changed` (the scripts differ from
// the approval, before or during the step) or `refused:<reason>`.
export type ScriptBindingOutcome =
  "bound" | "fenced-windows" | "scripts-changed" | `refused:${BoundScriptRefusal}`;

export const SCRIPT_BINDING_OUTCOMES = [
  "bound",
  "fenced-windows",
  "scripts-changed",
  "refused:script-shell-configured",
  "refused:ignore-scripts-configured",
  "refused:package-manager-configuration",
  "refused:lifecycle-order-unknown",
  "refused:package-config-unsupported",
  "refused:script-not-runnable",
  "refused:yarn-pnp-unsupported",
  "refused:approval-missing",
  "refused:windows-step-copy-missing",
] as const satisfies readonly ScriptBindingOutcome[];

// The program of the `sh` step. Constant, owned by Keiko, never built from repository text: it
// resolves the package folder against the execution root as the sandbox sees it, prefixes PATH with
// every `node_modules/.bin` from the package folder up to that root, sets what npm sets for a
// script, and runs each (event, bytes) pair through `/bin/sh -c`, stopping at the first failure.
export const BOUND_SCRIPT_WRAPPER = [
  "root=$PWD",
  "pkg=$root",
  '[ "$1" = . ] || pkg=$root/$1',
  "shift",
  'cd -- "$pkg" || exit 126',
  'd=$pkg; bin=""',
  'while [ -n "$d" ]; do',
  '  bin="$bin$d/node_modules/.bin:"',
  '  [ "$d" = "$root" ] && break',
  "  d=${d%/*}",
  "done",
  'PATH="${bin%:}${PATH:+:$PATH}"',
  "INIT_CWD=$root",
  "npm_package_json=$pkg/package.json",
  "export PATH INIT_CWD npm_package_json",
  'while [ "$#" -ge 2 ]; do',
  "  npm_lifecycle_event=$1",
  "  npm_lifecycle_script=$2",
  "  shift 2",
  "  export npm_lifecycle_event npm_lifecycle_script",
  '  /bin/sh -c "$npm_lifecycle_script" || exit "$?"',
  "done",
].join("\n");

export type BoundScript =
  | {
      readonly kind: "bound";
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
    }
  | { readonly kind: "changed" }
  | { readonly kind: "refused"; readonly reason: BoundScriptRefusal };

export interface BoundScriptInput {
  readonly step: VerificationStep;
  readonly workspace: WorkspaceInfo;
  readonly fs?: WorkspaceFs | undefined;
  readonly approvedDigest: string;
  // The host's Node.js and package manager paths: absent when the step runs in a container, where
  // those host paths do not exist, so the step is not handed paths that name nothing.
  readonly nodeExecPath?: string | undefined;
  readonly packageManagerPath?: string | undefined;
}

const RC_MAX_BYTES = 16_384;
// Settings of the project's own rc files that change how a script runs and that this run does not
// reproduce; a project that sets one is refused, never run unbound. `ignore-scripts` is the one
// setting that is reproduced. Yarn Berry's camelCase keys are matched in their kebab form.
const RC_REFUSALS: Readonly<Record<string, BoundScriptRefusal>> = Object.freeze({
  "script-shell": "script-shell-configured",
  "scripts-prepend-node-path": "package-manager-configuration",
  "enable-scripts": "package-manager-configuration",
});
const NPM_RC = ".npmrc";
const PNPM_WORKSPACE = "pnpm-workspace.yaml";
const OTHER_MANAGER_RC_FILES: readonly string[] = [NPM_RC, ".yarnrc", ".yarnrc.yml"];
// A Plug'n'Play project has no node_modules/.bin and needs the package manager's own loader.
const PNP_FILES: readonly string[] = [".pnp.cjs", ".pnp.js", ".pnp.loader.mjs"];

interface RcEntry {
  readonly key: string;
  readonly value: string;
}

function kebabKey(key: string): string {
  return key
    .replace(/^["']|["']$/gu, "")
    .replaceAll("_", "-")
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .toLowerCase();
}

function rcEntry(line: string): RcEntry | undefined {
  const text = line.trim();
  if (text === "" || text.startsWith("#") || text.startsWith(";")) return undefined;
  const cut = text.search(/[=:\s]/u);
  const key = cut === -1 ? text : text.slice(0, cut);
  const value =
    cut === -1
      ? ""
      : text
          .slice(cut)
          .replace(/^\s*[=:]?\s*/u, "")
          .trim();
  return { key: kebabKey(key), value: value.replace(/^["']|["']$/gu, "") };
}

// npm reads `ignore-scripts` as a boolean; a bare key is true. Anything else cannot be read.
function booleanSetting(value: unknown): boolean | undefined {
  if (value === true || value === "true" || value === "") return true;
  return value === false || value === "false" ? false : undefined;
}

interface ProjectSettings {
  ignoreScripts: boolean;
  // pnpm's `enablePrePostScripts` when a project sets it (default true); see `lifecycleRule`.
  prePost: boolean | undefined;
}

// The entries of an rc file's top level. npm's ini reader turns `[section]` into a nested object,
// which is not top-level configuration, so keys inside a section are ignored.
function topLevelEntries(text: string, yaml: boolean): readonly RcEntry[] {
  const entries: RcEntry[] = [];
  let inSection = false;
  for (const line of text.split(/[\r\n]+/u)) {
    // YAML nests by indentation: an indented key belongs to a parent mapping, not the top level.
    if (yaml && /^\s+\S/u.test(line)) continue;
    if (/^\s*\[.*\]\s*$/u.test(line)) inSection = true;
    else if (!inSection) {
      const entry = rcEntry(line);
      if (entry !== undefined) entries.push(entry);
    }
  }
  return entries;
}

// What a `node-linker` value means for a manager. npm has no such setting and ignores the key. Yarn
// runs from node_modules only with `node-modules`; pnpm links node_modules as `isolated` (default)
// or `hoisted`. `pnp` has no node_modules/.bin; any other value cannot be reproduced.
function linkerRefusal(manager: string, value: string): BoundScriptRefusal | undefined {
  if (manager === "npm") return undefined;
  if (value === "pnp") return "yarn-pnp-unsupported";
  const accepted = manager === "yarn" ? ["node-modules"] : ["isolated", "hoisted"];
  return accepted.includes(value) ? undefined : "package-manager-configuration";
}

interface RcFile {
  readonly npmOwned: boolean;
  readonly manager: string;
  readonly yaml: boolean;
}

// `enable-pre-post-scripts` is pnpm's setting. For pnpm it is read as a boolean and decides whether
// the lifecycle pair runs; npm and yarn have no such setting, and a project that sets it is refused.
function prePostSetting(
  entry: RcEntry,
  file: RcFile,
  settings: ProjectSettings,
): BoundScriptRefusal | undefined {
  const parsed = booleanSetting(entry.value);
  if (file.manager !== "pnpm" || parsed === undefined) return "package-manager-configuration";
  settings.prePost = parsed;
  return undefined;
}

function applyEntry(
  entry: RcEntry,
  file: RcFile,
  settings: ProjectSettings,
): BoundScriptRefusal | undefined {
  const refusal = RC_REFUSALS[entry.key];
  if (refusal !== undefined) return refusal;
  if (entry.key === "enable-pre-post-scripts") return prePostSetting(entry, file, settings);
  if (entry.key === "node-linker") return linkerRefusal(file.manager, entry.value);
  if (entry.key !== "ignore-scripts") return undefined;
  const parsed = booleanSetting(entry.value);
  // Only npm's own rc file is read by npm's rules; another manager's file is not reproduced.
  if (parsed === undefined || !file.npmOwned) return "ignore-scripts-configured";
  settings.ignoreScripts = parsed;
  return undefined;
}

function rcTextSettings(
  text: string,
  file: RcFile,
  settings: ProjectSettings,
): BoundScriptRefusal | undefined {
  for (const entry of topLevelEntries(text, file.yaml)) {
    const refusal = applyEntry(entry, file, settings);
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}

function rcFileSettings(
  path: string,
  fs: WorkspaceFs,
  manager: string,
  settings: ProjectSettings,
): BoundScriptRefusal | undefined {
  if (!fs.exists(path)) return undefined;
  const stat = fs.stat(path);
  const usable = stat.isFile && !stat.isSymbolicLink && stat.size <= RC_MAX_BYTES;
  const read = usable
    ? fs.readFileUtf8SameDescriptor?.(path, RC_MAX_BYTES, "reject", stat)
    : undefined;
  if (read === undefined) return "package-manager-configuration";
  return rcTextSettings(
    read.rawText,
    { npmOwned: path.endsWith(NPM_RC), manager, yaml: /\.ya?ml$/u.test(path) },
    settings,
  );
}

// What npm reads: with the package folder as `--prefix`, the project `.npmrc` is the one in that
// folder (the workspace root's when the root is the package), and no `.npmrc` of a parent folder.
// Yarn and pnpm also read rc files up the tree, so every workspace-level rc file of the root and the
// package folder is read for them. The person's home `.npmrc` is never read.
function rcPaths(
  workspace: WorkspaceInfo,
  packageDir: string | undefined,
  manager: string,
): readonly string[] {
  const prefix = packageDir === undefined ? workspace.root : join(workspace.root, packageDir);
  if (manager === "npm") return [join(prefix, NPM_RC)];
  const dirs = packageDir === undefined ? [prefix] : [workspace.root, prefix];
  const files = dirs.flatMap((dir) => OTHER_MANAGER_RC_FILES.map((name) => join(dir, name)));
  // pnpm 10 keeps its settings in `pnpm-workspace.yaml` (camelCase, top-level keys only).
  return manager === "pnpm" ? [...files, join(workspace.root, PNPM_WORKSPACE)] : files;
}

function pnpPresent(
  workspace: WorkspaceInfo,
  packageDir: string | undefined,
  fs: WorkspaceFs,
): boolean {
  const dirs =
    packageDir === undefined
      ? [workspace.root]
      : [workspace.root, join(workspace.root, packageDir)];
  return dirs.some((dir) => PNP_FILES.some((name) => fs.exists(join(dir, name))));
}

// `package.json#pnpm` holds the same camelCase settings; only its top-level keys are read.
function pnpmFieldRefusal(
  field: unknown,
  settings: ProjectSettings,
): BoundScriptRefusal | undefined {
  if (field === undefined) return undefined;
  if (typeof field !== "object" || field === null || Array.isArray(field)) {
    return "package-manager-configuration";
  }
  const file: RcFile = { npmOwned: false, manager: "pnpm", yaml: false };
  for (const [key, value] of Object.entries(field)) {
    const text = typeof value === "string" || typeof value === "boolean" ? String(value) : "?";
    const refusal = applyEntry({ key: kebabKey(key), value: text }, file, settings);
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}

function projectSettings(
  input: BoundScriptInput,
  fs: WorkspaceFs,
  root: PackageManifest | undefined,
): ProjectSettings | BoundScriptRefusal {
  const { workspace, step } = input;
  if (pnpPresent(workspace, step.cwd, fs)) return "yarn-pnp-unsupported";
  const settings: ProjectSettings = { ignoreScripts: false, prePost: undefined };
  for (const path of rcPaths(workspace, step.cwd, step.command)) {
    const refusal = rcFileSettings(path, fs, step.command, settings);
    if (refusal !== undefined) return refusal;
  }
  const fieldRefusal =
    step.command === "pnpm" ? pnpmFieldRefusal(root?.fields.pnpm, settings) : undefined;
  return fieldRefusal ?? settings;
}

function isPrimitiveConfig(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

interface ConfigResult {
  readonly env: Readonly<Record<string, string>>;
  readonly ignoreScripts: boolean | undefined;
}

function configEntryRefusal(key: string, value: unknown): BoundScriptRefusal | undefined {
  if (key === "script-shell") return "script-shell-configured";
  if (key === "ignore-scripts" && booleanSetting(value) === undefined) {
    return "ignore-scripts-configured";
  }
  // The key becomes part of an environment variable name: it needs one, and no `=`.
  const nameable = key !== "" && !key.includes("=");
  return isPrimitiveConfig(value) && nameable ? undefined : "package-config-unsupported";
}

// What `package.json` `config` becomes: `npm_package_config_<key>` for each primitive entry. A
// shell setting, an unreadable `ignore-scripts` or a nested value npm flattens is not reproduced.
function configEnvironment(config: unknown): ConfigResult | BoundScriptRefusal {
  if (config === undefined) return { env: {}, ignoreScripts: undefined };
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return "package-config-unsupported";
  }
  const env: Record<string, string> = {};
  let ignoreScripts: boolean | undefined;
  for (const [key, value] of Object.entries(config)) {
    const normalized = key.replaceAll("_", "-");
    const refusal = configEntryRefusal(normalized, value);
    if (refusal !== undefined) return refusal;
    if (normalized === "ignore-scripts") ignoreScripts = booleanSetting(value);
    env[`npm_package_config_${key}`] = String(value);
  }
  return { env, ignoreScripts };
}

type Phases = readonly (readonly [string, string])[];

// The scripts npm runs for `<name>`, in its order. With `ignore-scripts` npm still runs the script
// a command names (`npm test`, `npm run`) but skips its pre and post scripts. Yarn and pnpm differ
// by version in whether they run the lifecycle pair and in what `ignore-scripts` does, and the
// version is not known here: a script with such a pair, or any `ignore-scripts`, is refused for
// them, never run in a guessed order.
// One argument of a spawn is limited by the kernel (128 KiB on Linux) and the whole vector and
// environment together (about 1 MiB on macOS): a script beyond these bounds is refused before the
// spawn instead of failing it with E2BIG.
const MAX_SCRIPT_BYTES = 65_536;
const MAX_TOTAL_SCRIPT_BYTES = 262_144;

function runnableText(texts: readonly string[]): boolean {
  let total = 0;
  for (const text of texts) {
    if (text.includes("\u0000")) return false;
    const bytes = Buffer.byteLength(text, "utf8");
    total += bytes;
    if (bytes > MAX_SCRIPT_BYTES || total > MAX_TOTAL_SCRIPT_BYTES) return false;
  }
  return true;
}

// Whether a manager runs a script's `pre<name>` and `post<name>`. npm always does. Yarn classic does;
// Yarn Berry (2 and later) does not. pnpm runs them unless `enablePrePostScripts` is false: its
// documented default is true (pnpm.io/settings), so an explicit setting settles it either way. With
// no setting, pnpm 8 and later run them; pnpm 7 changed the default around then, which is not
// verified here, so it and an absent or unknown version settle nothing. The version comes from the
// root `packageManager` field (`pnpm@8.6.0`).
type LifecycleRule = "run" | "skip" | "unknown";

function pnpmLifecycle(major: number | undefined, prePost: boolean | undefined): LifecycleRule {
  if (prePost !== undefined) return prePost ? "run" : "skip";
  return major !== undefined && major >= 8 ? "run" : "unknown";
}

function lifecycleRule(
  step: VerificationStep,
  packageManager: unknown,
  prePost: boolean | undefined,
): LifecycleRule {
  if (step.command === "npm") return "run";
  const spec = typeof packageManager === "string" ? packageManager : "";
  const match = new RegExp(String.raw`^${step.command}@(\d+)\.`, "u").exec(spec);
  const major = match?.[1] === undefined ? undefined : Number(match[1]);
  if (step.command === "pnpm") return pnpmLifecycle(major, prePost);
  if (major === undefined) return "unknown";
  return major >= 2 ? "skip" : "run";
}

function phasesOf(
  step: VerificationStep,
  scripts: Readonly<Record<string, string>>,
  settings: { readonly ignoreScripts: boolean; readonly lifecycle: LifecycleRule },
): Phases | BoundScriptRefusal {
  const name = step.scriptName;
  const body = name === undefined ? undefined : scripts[name];
  if (name === undefined || body === undefined) return "script-not-runnable";
  // `ignore-scripts` is reproduced for npm only; another manager's handling is not verified here.
  if (settings.ignoreScripts && step.command !== "npm") return "ignore-scripts-configured";
  const [pre, post] = lifecycleScripts(name, scripts, settings);
  if (settings.lifecycle === "unknown" && (pre !== undefined || post !== undefined)) {
    return "lifecycle-order-unknown";
  }
  return npmPhases(name, body, pre, post);
}

function lifecycleScripts(
  name: string,
  scripts: Readonly<Record<string, string>>,
  settings: { readonly ignoreScripts: boolean; readonly lifecycle: LifecycleRule },
): readonly [string | undefined, string | undefined] {
  if (settings.ignoreScripts || settings.lifecycle === "skip") return [undefined, undefined];
  return [scripts[`pre${name}`], scripts[`post${name}`]];
}

function npmPhases(
  name: string,
  body: string,
  pre: string | undefined,
  post: string | undefined,
): Phases | BoundScriptRefusal {
  const phases: Phases = [
    ...(pre === undefined ? [] : [[`pre${name}`, pre] as const]),
    [name, body] as const,
    ...(post === undefined ? [] : [[`post${name}`, post] as const]),
  ];
  return runnableText(phases.map(([, text]) => text)) ? phases : "script-not-runnable";
}

function isRefusal(value: unknown): value is BoundScriptRefusal {
  return typeof value === "string";
}

function manifestEnvironment(
  input: BoundScriptInput,
  fields: Readonly<Record<string, unknown>>,
  config: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const { step } = input;
  const { name, version } = fields;
  return {
    ...config,
    ...(typeof name === "string" ? { npm_package_name: name } : {}),
    ...(typeof version === "string" ? { npm_package_version: version } : {}),
    npm_command: step.command === "npm" && step.args[0] === "test" ? "test" : "run-script",
    // npm sets `NODE` to the Node.js that runs it. `npm_config_user_agent` is not set: it carries the
    // npm version and the person's user config, which this run does not read.
    ...(input.nodeExecPath === undefined
      ? {}
      : { NODE: input.nodeExecPath, npm_node_execpath: input.nodeExecPath }),
    ...(input.packageManagerPath === undefined ? {} : { npm_execpath: input.packageManagerPath }),
  };
}

// The refusal that applies to a manifest whose scripts match the approval, or the phases to run.
function runnable(
  input: BoundScriptInput,
  manifest: PackageManifest,
  fs: WorkspaceFs,
):
  | { readonly phases: Phases; readonly config: Readonly<Record<string, string>> }
  | BoundScriptRefusal {
  // The root manifest is read once: its `packageManager` names the version and its `pnpm` key holds
  // pnpm's settings. A root package is the manifest this binding already holds.
  const root = input.step.cwd === undefined ? manifest : readPackageManifest(input.workspace, fs);
  const project = projectSettings(input, fs, root);
  if (isRefusal(project)) return project;
  const config = configEnvironment(manifest.fields.config);
  if (isRefusal(config)) return config;
  const ignoreScripts = config.ignoreScripts ?? project.ignoreScripts;
  const lifecycle = lifecycleRule(input.step, root?.fields.packageManager, project.prePost);
  const phases = phasesOf(input.step, manifest.scripts, { ignoreScripts, lifecycle });
  return isRefusal(phases) ? phases : { phases, config: config.env };
}

// Reads the manifest once and decides: the approved bytes to run, a mismatch with the approval, or
// a closed refusal. The returned arguments carry the bytes of THAT read.
export function bindApprovedScript(input: BoundScriptInput): BoundScript {
  const fs = input.fs ?? nodeWorkspaceFs;
  const manifest = readPackageManifest(input.workspace, fs, input.step.cwd);
  if (manifest === undefined || scriptTableDigest(manifest.scripts) !== input.approvedDigest) {
    return { kind: "changed" };
  }
  const plan = runnable(input, manifest, fs);
  if (isRefusal(plan)) return { kind: "refused", reason: plan };
  const env = manifestEnvironment(input, manifest.fields, plan.config);
  if (!runnableText([...Object.keys(env), ...Object.values(env)]))
    return { kind: "refused", reason: "script-not-runnable" };
  return {
    kind: "bound",
    args: [
      "-c",
      BOUND_SCRIPT_WRAPPER,
      "keiko-script",
      input.step.cwd ?? ".",
      ...plan.phases.flat(),
    ],
    env,
  };
}
