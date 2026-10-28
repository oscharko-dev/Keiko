#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { resolveQualityRange } from "./resolve-quality-range.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHA = /^[0-9a-f]{40}$/u;
const ACCEPTED_AUDIT_VERDICTS = new Set(["pass", "warn"]);
export const SEMANTIC_DUPLICATION_CONFIG = {
  duplicates: {
    mode: "semantic",
    minTokens: 100,
    minLines: 10,
    minOccurrences: 2,
    ignoreImports: true,
    ignoreDefaults: false,
    ignore: [],
    ignoredClones: [],
    normalization: { ignoreStringValues: false },
  },
};

// This artifact predates the strict string-preserving, full-source configuration. It is
// historical reporting input, never a suppression source or a veto for the mandatory audit.
export const DUPES_BASELINE = "docs/qa/fallow/dupes-baseline.json";
export const FALLOW_DUPES_ARGS = Object.freeze([
  "dupes",
  "--mode",
  "semantic",
  "--min-tokens",
  "100",
  "--min-lines",
  "10",
  "--ignore-imports",
  "--no-package-baselines",
]);

/** Select report groups for a diagnostic view without narrowing the mandatory audit. */
export function ownedGroups(groups, changed) {
  if (changed === undefined) return groups;
  return groups.filter((group) => group.instances.some((instance) => changed.has(instance.file)));
}

/** Read a legacy diagnostic count; absence is not evidence that a baseline check passed. */
export function staleEntries(staleness) {
  return typeof staleness?.stale_entries === "number" ? staleness.stale_entries : 0;
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateSemanticDuplicationConfig(value) {
  return isDeepStrictEqual(value, SEMANTIC_DUPLICATION_CONFIG);
}

function count(value) {
  requireCondition(Number.isSafeInteger(value) && value >= 0, "invalid analysis count");
  return value;
}

function validateHeader(report, base, head) {
  requireCondition(
    report?.kind === "audit" && report.command === "audit",
    "invalid audit envelope",
  );
  requireCondition(
    report.schema_version === 13 && report.version === "3.35.0",
    "unsupported audit protocol",
  );
  requireCondition(report.base_ref === base, "audit base mismatch");
  requireCondition(
    typeof report.head_sha === "string" &&
      /^[0-9a-f]{7,40}$/u.test(report.head_sha) &&
      head.startsWith(report.head_sha),
    "audit head mismatch",
  );
  requireCondition(ACCEPTED_AUDIT_VERDICTS.has(report.verdict), "audit analysis failed");
  requireCondition(
    report.base_snapshot_skipped === undefined || typeof report.base_snapshot_skipped === "boolean",
    "invalid base snapshot state",
  );
}

function validateSelection(summary) {
  requireCondition(
    summary?.dead_code_skipped === true &&
      summary.complexity_skipped === true &&
      (summary.duplication_skipped === undefined || summary.duplication_skipped === false),
    "invalid analysis selection",
  );
  return count(summary.duplication_clone_groups);
}

function validateGroups(groups, total, introduced, inherited) {
  let actualIntroduced = 0;
  for (const group of groups) {
    requireCondition(typeof group?.introduced === "boolean", "missing clone attribution");
    requireCondition(
      count(group.token_count) >= 100 &&
        count(group.line_count) >= 10 &&
        Array.isArray(group.instances) &&
        group.instances.length >= 2,
      "invalid clone group",
    );
    if (group.introduced) actualIntroduced += 1;
  }
  requireCondition(
    groups.length === total &&
      introduced > 0 === actualIntroduced > 0 &&
      inherited > 0 === groups.length > actualIntroduced,
    "incomplete clone attribution",
  );
}

export function validateSemanticDuplicationReport(report, base, head) {
  validateHeader(report, base, head);
  const changed = count(report.changed_files_count);
  const total = validateSelection(report.summary);
  const attribution = report.attribution;
  requireCondition(attribution?.gate === "new-only", "invalid attribution gate");
  const introduced = count(attribution.duplication_introduced);
  const inherited = count(attribution.duplication_inherited);
  requireCondition(
    introduced <= total &&
      inherited <= total &&
      Number.isSafeInteger(introduced + inherited) &&
      introduced + inherited <= total,
    "inconsistent attribution counts",
  );
  const groups = report.duplication?.clone_groups;
  requireCondition(
    Array.isArray(groups) || (changed === 0 && total === 0 && report.duplication === undefined),
    "missing duplication analysis",
  );
  validateGroups(groups ?? [], total, introduced, inherited);
  return introduced;
}

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  requireCondition(
    result.error === undefined && result.signal === null && result.status === 0,
    "analysis command failed",
  );
  return result.stdout.trim();
}

export function semanticDuplicationEnvironment(env = process.env) {
  return {
    ...Object.fromEntries(Object.entries(env).filter(([key]) => !/^(?:FALLOW|GIT)_/iu.test(key))),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    LC_ALL: "C",
  };
}

function immutableRange(args, git) {
  requireCondition(
    args.length === 2 &&
      args[0] === "--changed-since" &&
      typeof args[1] === "string" &&
      args[1].length > 0,
    "expected --changed-since with a Git revision",
  );
  const candidate = git(["rev-parse", "--verify", "--end-of-options", `${args[1]}^{commit}`]);
  requireCondition(SHA.test(candidate) && candidate !== "0".repeat(40), "invalid resolved base");
  const head = git(["rev-parse", "--verify", "HEAD"]);
  return resolveQualityRange({ base: candidate, head, eventName: "pull_request" }, git);
}

function analyze(repoRoot, base, head, execute, env) {
  const configPath = join(repoRoot, ".fallowrc.json");
  const config = readFileSync(configPath, "utf8");
  requireCondition(
    validateSemanticDuplicationConfig(JSON.parse(config)),
    "invalid duplication configuration",
  );
  const output = execute(
    process.execPath,
    [
      join(repoRoot, "node_modules/fallow/bin/fallow"),
      "audit",
      "--only",
      "dupes",
      "--gate",
      "new-only",
      "--format",
      "json",
      "--config",
      configPath,
      "--base",
      base,
    ],
    repoRoot,
    env,
  );
  const introduced = validateSemanticDuplicationReport(JSON.parse(output), base, head);
  requireCondition(
    readFileSync(configPath, "utf8") === config,
    "duplication configuration changed",
  );
  return introduced;
}

export function main(args = process.argv.slice(2), options = {}) {
  const {
    repoRoot = REPO_ROOT,
    execute = run,
    env: sourceEnv = process.env,
    log = console.log,
    error = console.error,
  } = options;
  try {
    const env = semanticDuplicationEnvironment(sourceEnv);
    const git = (gitArgs) => execute(resolveHostExecutable("git"), gitArgs, repoRoot, env);
    const { base, head } = immutableRange(args, git);
    const introduced = analyze(repoRoot, base, head, execute, env);
    requireCondition(git(["rev-parse", "--verify", "HEAD"]) === head, "repository head changed");
    if (introduced > 0) {
      error(`semantic-duplication: FAIL — ${introduced} introduced clone groups`);
      return 1;
    }
    log("semantic-duplication: PASS — zero introduced clone groups");
    return 0;
  } catch {
    error("semantic-duplication: FAIL — invalid range, configuration, or analysis evidence");
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
