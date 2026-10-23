#!/usr/bin/env node
import { readFileSync } from "node:fs";
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
import { runnerIdentity, runNativePolicy } from "./lib/code-quality-runner.mjs";

import { buildResponsibilityProofPackages } from "./lib/code-quality-responsibility-proofs.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FAILURE_REASONS = new Set([
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
    else {
      applyPolicyOption(options, key, args[++index]);
    }
  }
  validatePolicyOptions(options, ci);
  return options;
}

function validatePolicyOptions(options, ci) {
  if (!["enforce", "census"].includes(options.mode)) throw new TypeError("invalid-mode");
  if (options.qualifyResponsibilities === true && options.mode !== "enforce")
    throw new TypeError("invalid-mode");
  if (ci && (options.scope !== "repository" || options.mode !== "enforce"))
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
  const { inventory } = subject;
  const { scope, pack } = policyScopeAndPack(repositoryRoot, inventory, policy, options, progress);
  const scan = policyStep(progress, "native-scan", () =>
    runNativePolicy(repositoryRoot, scope.files),
  );
  const inventorySha256 = policyDigest(JSON.stringify(inventory));
  const rawAssessment = policyStep(progress, "raw-assessment", () =>
    assessPolicyDiagnostics(scan.diagnostics, scope.files, policy),
  );
  let responsibilities = policyResponsibilities(options, subject, policy, progress);
  if (options.qualifyResponsibilities === true) responsibilities = await responsibilities;
  const assessed = policyStep(progress, "diagnostic-adaptation", () =>
    responsibilities
      ? adaptResponsibilityDiagnostics(rawAssessment, responsibilities)
      : rawAssessment,
  );
  await asyncPolicyStep(progress, "final-currentness", () =>
    assertPolicySubjectCurrent(repositoryRoot, source, inventorySha256),
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
  });
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
  if (policy.version !== 2) return null;
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
}) {
  return {
    schemaVersion: policy.version,
    subject: inventory.subject,
    mode: options.mode,
    scope: { id: scope.id, partial: scope.partial },
    outcome: policyOutcome(options, assessed, responsibilities),
    policySha256: policyDigest(source),
    tools,
    configSha256: scan.configSha256,
    inventorySha256,
    ...policyScanSummary(policy, inventory, scope, scan, assessed),
    ...assessed,
    inventory,
    pack,
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

async function assertPolicySubjectCurrent(repositoryRoot, source, inventorySha256) {
  if (
    policyDigest(JSON.stringify(await collectPolicyInventory(repositoryRoot))) !==
      inventorySha256 ||
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
  return (report.enforcementOutcome ?? report.outcome) === "passed" ? 0 : 1;
}

function validateActiveScopes(policy, files) {
  for (const rule of policy.rules) {
    for (const id of rule.activeScopes) selectPolicyScope(files, id, false);
  }
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
