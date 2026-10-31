#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  collectPolicyInventory,
  collectPolicySubject,
  policyDigest,
  readPreviousPolicies,
  selectPolicyScope,
} from "./lib/code-quality-inventory.mjs";
import { collectPolicyPackages } from "./lib/code-quality-packages.mjs";
import {
  assessPolicyDiagnostics,
  validatePolicy,
  POLICY_PROGRESS_LIMITS,
  policyProgressLine,
} from "./lib/code-quality-policy.mjs";
import {
  adaptResponsibilityDiagnostics,
  assessPolicyResponsibilities,
  qualifyPolicyResponsibilities,
} from "./lib/code-quality-responsibilities.mjs";
import {
  compareRegister,
  countRegisterFindings,
  parseRegister,
  pruneRegister,
  REGISTER_PATH,
  registerTotal,
  serializeRegister,
} from "./lib/code-quality-register.mjs";
import { runnerIdentity, runNativePolicy } from "./lib/code-quality-runner.mjs";

import { buildResponsibilityProofPackages } from "./lib/code-quality-responsibility-proofs.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FAILURE_REASONS = new Set([
  "retired-scope-owner-present",
  "retired-scope-membership-changed",
  "invalid-arguments",
  "invalid-mode",
  "partial-ci-verdict",
  "invalid-policy",
  "invalid-policy-identity",
  "invalid-rule-inventory",
  "initial-guard-disabled",
  "invalid-baseline-policy",
  "activation-shrank",
  "invalid-responsibilities",
  "responsibility-downgrade",
  "responsibility-shrank",
  "tool-identity-mismatch",
  "runtime-tool-dependency",
  "upstream-identity-mismatch",
  "upstream-source-mismatch",
  "upstream-source-inventory-mismatch",
  "unsafe-upstream-source",
  "upstream-transpile-failed",
  "inventory-workspace-escape",
  "invalid-build-config",
  "production-source-escape",
  "invalid-production-source",
  "invalid-production-target",
  "ambiguous-production-output",
  "unmapped-production-export",
  "unaccounted-production-import",
  "production-source-changed",
  "unclassified-source",
  "partial-ci-scope",
  "unknown-or-empty-scope",
  "invalid-export-target",
  "unsafe-source-file",
  "workspace-inventory-mismatch",
  "empty-source-inventory",
  "unclassified-html-source",
  "npm-invocation-required",
  "pack-inventory-mismatch",
  "unpacked-export-target",
  "unknown-diagnostic",
  "runner-execution-failed",
  "invalid-runner-report",
  "incomplete-parser-visitation",
  "runner-exit-mismatch",
  "inline-policy-suppression",
  "source-argument-too-long",
  "subject-changed-during-scan",
  "incomplete-policy-history",
  "semantic-proof-assertion-missing",
  "semantic-proof-build-failed",
  "semantic-proof-tool-unavailable",
  "semantic-proof-runtime-unavailable",
  "semantic-proof-report-invalid",
  "semantic-proof-execution-failed",
  "semantic-proof-timeout",
  "semantic-proof-output-limit",
  "semantic-proof-spawn-failed",
  "semantic-proof-process-not-drained",
  "semantic-proof-drain-unavailable",
  "semantic-proof-subject-changed",
  "missing-code-quality-register",
  "invalid-code-quality-register",
  "noncanonical-code-quality-register",
  "code-quality-register-exists",
  "code-quality-register-increase",
  "register-write-in-ci",
]);

const REGISTER_ACTIONS = new Map([
  ["--prune-register", "prune"],
  ["--initialize-register", "initialize"],
]);

export function parsePolicyArguments(args, ci = process.env.CI === "true") {
  const options = { mode: "enforce", scope: "repository", json: false };
  const supplied = new Set();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (supplied.has(key)) throw new TypeError("invalid-arguments");
    supplied.add(key);
    if (key === "--json") options.json = true;
    else if (key === "--progress") options.progress = true;
    else if (key === "--qualify-responsibilities") options.qualifyResponsibilities = true;
    else if (REGISTER_ACTIONS.has(key)) applyRegisterAction(options, REGISTER_ACTIONS.get(key));
    else {
      applyPolicyOption(options, key, args[++index]);
    }
  }
  if (options.registerAction !== undefined && !supplied.has("--mode")) options.mode = "ratchet";
  validatePolicyOptions(options, ci);
  return options;
}

function validateRegisterOptions(options, ci) {
  if (options.registerAction !== undefined && options.mode !== "ratchet")
    throw new TypeError("invalid-mode");
  if (options.mode === "ratchet" && options.scope !== "repository")
    throw new TypeError("partial-ci-scope");
  if (ci && options.registerAction !== undefined) throw new TypeError("register-write-in-ci");
}

function applyRegisterAction(options, action) {
  if (options.registerAction !== undefined) throw new TypeError("invalid-arguments");
  options.registerAction = action;
}

function validatePolicyOptions(options, ci) {
  if (!["enforce", "census", "ratchet"].includes(options.mode)) throw new TypeError("invalid-mode");
  if (options.qualifyResponsibilities === true && options.mode !== "enforce")
    throw new TypeError("invalid-mode");
  validateRegisterOptions(options, ci);
  if (ci && (options.scope !== "repository" || options.mode === "census"))
    throw new TypeError("partial-ci-verdict");
}

function applyPolicyOption(options, key, value) {
  if (!["--mode", "--scope"].includes(key) || value === undefined || value.startsWith("--")) {
    throw new TypeError("invalid-arguments");
  }
  options[key.slice(2)] = value;
}

function createPolicyProgress(options) {
  const started = options.progress === true ? performance.now() : 0;
  let frames = 0;
  return (phase, state) => {
    if (options.progress !== true || frames >= POLICY_PROGRESS_LIMITS.frames) return;
    frames += 1;
    const line = policyProgressLine({
      version: 1,
      phase,
      state,
      elapsedMs: Math.floor(performance.now() - started),
    });
    if (line !== null) process.stderr.write(line);
  };
}

function policyStep(progress, phase, run) {
  progress(phase, "started");
  const result = run();
  progress(phase, "completed");
  return result;
}

async function asyncPolicyStep(progress, phase, run) {
  progress(phase, "started");
  const result = await run();
  progress(phase, "completed");
  return result;
}

function validatedPolicy(repositoryRoot) {
  const source = readFileSync(resolve(repositoryRoot, "scripts/code-quality-policy.json"));
  const policy = JSON.parse(source);
  const errors = validatePolicy(policy, readPreviousPolicies(repositoryRoot));
  if (errors.length > 0) throw new TypeError(errors[0]);
  return { source, policy };
}

export async function executeCodeQualityPolicy(
  options,
  repositoryRoot = root,
  progress = createPolicyProgress(options),
) {
  const { source, policy } = policyStep(progress, "policy-validation", () =>
    validatedPolicy(repositoryRoot),
  );
  if (options.qualifyResponsibilities === true)
    await asyncPolicyStep(progress, "semantic-build", () =>
      buildSemanticPolicyPackages(options, policy, repositoryRoot, source),
    );
  const tools = policyStep(progress, "tool-identity", runnerIdentity);
  const subject = await asyncPolicyStep(progress, "subject-inventory", () =>
    collectPolicySubject(repositoryRoot),
  );
  const { inventory, scopeRetirements } = policySubjectApplicability(policy, subject);
  const { scope, pack } = policyScopeAndPack(repositoryRoot, inventory, policy, options, progress);
  const scan = policyStep(progress, "native-scan", () =>
    runNativePolicy(repositoryRoot, scope.files),
  );
  const inventorySha256 = policyDigest(JSON.stringify(inventory));
  const rawAssessment = policyStep(progress, "raw-assessment", () =>
    assessPolicyDiagnostics(scan.diagnostics, scope.files, policy),
  );
  const responsibilities = await policyResponsibilities(options, subject, policy, progress);
  const assessed = policyStep(progress, "diagnostic-adaptation", () =>
    responsibilities
      ? adaptResponsibilityDiagnostics(rawAssessment, responsibilities)
      : rawAssessment,
  );
  await asyncPolicyStep(progress, "final-currentness", () =>
    assertPolicySubjectCurrent(repositoryRoot, source, inventorySha256, scopeRetirements),
  );
  return policyReport({
    options,
    policy,
    source,
    tools,
    inventory,
    scope,
    pack,
    scan,
    assessed,
    responsibilities,
    inventorySha256,
    scopeRetirements,
    register: policyRegisterStep(options, repositoryRoot, scan, scope, progress),
  });
}

function policyRegisterStep(options, repositoryRoot, scan, scope, progress) {
  if (options.mode !== "ratchet") return null;
  return policyStep(progress, "register", () =>
    applyPolicyRegister(options, repositoryRoot, scan.diagnostics, scope.files),
  );
}

function readPolicyRegister(path) {
  if (!existsSync(path)) throw new TypeError("missing-code-quality-register");
  return parseRegister(readFileSync(path, "utf8"));
}

function registerFindingLines(diagnostics, { path, rule }) {
  return diagnostics
    .filter((entry) => entry.path === path && entry.rule === rule)
    .map((entry) => entry.line)
    .sort((left, right) => left - right);
}

// Compares, prunes or initializes the shrink-only register (#4145) after the subject is proven
// current, so a write can never describe a tree the scan did not observe.
function applyPolicyRegister(options, repositoryRoot, diagnostics, files) {
  const path = resolve(repositoryRoot, REGISTER_PATH);
  const current = countRegisterFindings(diagnostics);
  const scanned = new Set(files.map((file) => file.path));
  if (options.registerAction === "initialize") {
    if (existsSync(path)) throw new TypeError("code-quality-register-exists");
    writeFileSync(path, serializeRegister(current), { flag: "wx" });
    return { action: "initialize", ...compareRegister(current, current, scanned), before: 0 };
  }
  const committed = readPolicyRegister(path);
  if (options.registerAction === "prune") {
    writeFileSync(path, serializeRegister(pruneRegister(committed, current, scanned)));
    const pruned = compareRegister(current, current, scanned);
    return { action: "prune", ...pruned, before: registerTotal(committed) };
  }
  const comparison = compareRegister(committed, current, scanned);
  const increases = comparison.increases.map((entry) => ({
    ...entry,
    lines: registerFindingLines(diagnostics, entry),
  }));
  return { action: "compare", ...comparison, increases };
}

function policySubjectApplicability(policy, subject) {
  const { inventory } = subject;
  return { inventory, scopeRetirements: initialScopeRetirements(policy, subject.membership.paths) };
}

function policyScopeAndPack(repositoryRoot, inventory, policy, options, progress) {
  const scope = selectPolicyScope(inventory.files, options.scope, process.env.CI === "true");
  validateActiveScopes(policy, inventory.files);
  const pack = policyStep(progress, "package-inventory", () =>
    collectPolicyPackages(repositoryRoot, inventory.packages),
  );
  return { scope, pack };
}

function policyResponsibilities(options, subject, policy, progress) {
  // The ratchet compares raw findings only; responsibility qualification belongs to enforce.
  if (policy.version !== 2 || options.mode === "ratchet") return null;
  if (options.qualifyResponsibilities === true)
    return asyncPolicyStep(progress, "responsibilities", () =>
      qualifyPolicyResponsibilities(subject, policy),
    );
  return policyStep(progress, "responsibilities", () =>
    assessPolicyResponsibilities(subject, policy),
  );
}

function policyReport({
  options,
  policy,
  source,
  tools,
  inventory,
  scope,
  pack,
  scan,
  assessed,
  responsibilities,
  inventorySha256,
  scopeRetirements,
  register,
}) {
  return {
    schemaVersion: policy.version,
    subject: inventory.subject,
    mode: options.mode,
    scope: { id: scope.id, partial: scope.partial },
    outcome: register ? register.outcome : policyOutcome(options, assessed, responsibilities),
    policySha256: policyDigest(source),
    tools,
    configSha256: scan.configSha256,
    inventorySha256,
    scopeRetirements,
    ...policyScanSummary(policy, inventory, scope, scan, assessed),
    ...assessed,
    inventory,
    pack,
    ...(register ? { register } : {}),
    ...(responsibilities
      ? { responsibilities, enforcementOutcome: enforcementOutcome(assessed, responsibilities) }
      : {}),
  };
}

async function buildSemanticPolicyPackages(options, policy, repositoryRoot, source) {
  if (options.mode !== "enforce") throw new TypeError("invalid-mode");
  if (
    policy.version !== 2 ||
    !policy.responsibilities.length ||
    policy.responsibilities.some((record) => !record.proofAssertions?.length)
  )
    throw new TypeError("semantic-proof-assertion-missing");
  const beforeBuild = policyDigest(JSON.stringify(await collectPolicyInventory(repositoryRoot)));
  await buildResponsibilityProofPackages(repositoryRoot);
  await assertPolicySubjectCurrent(repositoryRoot, source, beforeBuild);
}

function policyScanSummary(policy, inventory, scope, scan, assessed) {
  return {
    counts: {
      expected: scope.files.length,
      visited: scan.visited,
      findings: scan.diagnostics.length,
      violations: assessed.violations.length,
      packages: inventory.packages.length,
      html: inventory.html.length,
    },
    rules: policy.rules.map((rule) => ({
      ...rule,
      findings: scan.diagnostics.filter((entry) => entry.rule === rule.id).length,
    })),
  };
}

function retiredScopeWitness(paths) {
  const owner = "native/opencode-service-host";
  if (paths.some((path) => path === owner || path.startsWith(`${owner}/`)))
    throw new TypeError("retired-scope-owner-present");
  return {
    scope: "native-host",
    state: "owner-absent",
    ownerMemberCount: 0,
    obligationCount: 5,
    pathCount: paths.length,
    pathsSha256: policyDigest(JSON.stringify(paths)),
  };
}

function initialScopeRetirements(policy, paths) {
  return policy.rules.some((rule) => Object.hasOwn(rule, "retiredScopes"))
    ? [retiredScopeWitness(paths)]
    : [];
}

function assertScopeRetirementsCurrent(scopeRetirements, paths) {
  if (scopeRetirements.length === 0) return;
  const current = retiredScopeWitness(paths);
  const initial = scopeRetirements[0];
  if (current.pathCount !== initial.pathCount || current.pathsSha256 !== initial.pathsSha256)
    throw new TypeError("retired-scope-membership-changed");
}

async function assertPolicySubjectCurrent(
  repositoryRoot,
  source,
  inventorySha256,
  scopeRetirements = [],
) {
  const current = await collectPolicySubject(repositoryRoot);
  assertScopeRetirementsCurrent(scopeRetirements, current.membership.paths);
  if (
    policyDigest(JSON.stringify(current.inventory)) !== inventorySha256 ||
    policyDigest(readFileSync(resolve(repositoryRoot, "scripts/code-quality-policy.json"))) !==
      policyDigest(source)
  )
    throw new TypeError("subject-changed-during-scan");
}

function policyOutcome(options, assessed, responsibilities) {
  const incomplete =
    responsibilities &&
    (responsibilities.assessments.length === 0 ||
      responsibilities.counts.qualified !== responsibilities.assessments.length);
  return incomplete || (options.mode === "enforce" && assessed.violations.length > 0)
    ? "failed"
    : "passed";
}

function enforcementOutcome(assessed, responsibilities) {
  const incomplete = responsibilities.assessments.some((record) => record.structural !== "ready");
  return assessed.violations.length > 0 || incomplete ? "failed" : "passed";
}

function reportVerdict(report) {
  return report.schemaVersion === 2
    ? `enforcement=${report.enforcementOutcome.toUpperCase()}; combined=${report.outcome.toUpperCase()}; semantic-qualified=${report.responsibilities.counts.qualified}; semantic-pending=${report.responsibilities.counts.pending}`
    : report.outcome.toUpperCase();
}

function policyExitCode(report) {
  if (report.responsibilities?.execution && report.outcome !== "passed") return 1;
  if (report.mode === "census") return 0;
  if (report.mode === "ratchet") return report.outcome === "passed" ? 0 : 1;
  return (report.enforcementOutcome ?? report.outcome) === "passed" ? 0 : 1;
}

function validateActiveScopes(policy, files) {
  for (const rule of policy.rules) {
    for (const id of rule.activeScopes) selectPolicyScope(files, id, false);
  }
}

function signedDelta(delta) {
  return delta < 0 ? `${delta}` : `+${delta}`;
}

const PRUNE_HINT = "run `npm run check:code-quality-policy -- --prune-register` and commit it";

function printRegisterReport(report) {
  const { register } = report;
  console.log(
    `code-quality-policy: ratchet ${report.outcome.toUpperCase()} - ${report.counts.visited} files; ${report.counts.findings} findings; ${register.action}`,
  );
  console.log(
    `register: ${register.before} → ${register.after} (${signedDelta(register.after - register.before)})`,
  );
  for (const entry of register.increases)
    console.log(
      `increase: ${entry.path} ${entry.rule} ${entry.before} → ${entry.after}; lines ${entry.lines.join(",")}`,
    );
  for (const entry of register.decreases)
    console.log(`decrease: ${entry.path} ${entry.rule} ${entry.before} → ${entry.after}`);
  for (const path of register.stale) console.log(`stale: ${path}`);
  if (register.decreases.length + register.stale.length > 0) console.log(`register: ${PRUNE_HINT}`);
}

export async function codeQualityPolicyMain(args = process.argv.slice(2), repositoryRoot = root) {
  try {
    const options = parsePolicyArguments(args);
    const progress = createPolicyProgress(options);
    const report = await executeCodeQualityPolicy(options, repositoryRoot, progress);
    if (options.json) {
      const serialized = policyStep(progress, "report-serialization", () =>
        JSON.stringify(report, null, 2),
      );
      console.log(serialized);
    } else if (report.register) {
      printRegisterReport(report);
    } else {
      console.log(
        `code-quality-policy: ${reportVerdict(report)} - ${report.counts.visited} files; ${report.counts.violations} active findings; ${report.scope.partial ? "partial" : "repository"}`,
      );
      for (const finding of report.violations) console.log(JSON.stringify(finding));
    }
    return policyExitCode(report);
  } catch (error) {
    const reason = FAILURE_REASONS.has(error.message)
      ? error.message
      : "analyzer-qualification-failed";
    console.error(
      `code-quality-policy: FAIL - ${reason}; repair the named policy, inventory or analyzer obligation`,
    );
    return 1;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = await codeQualityPolicyMain();
}
