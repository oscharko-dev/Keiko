#!/usr/bin/env node
import { readFileSync } from "node:fs";
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
import { assessPolicyDiagnostics, validatePolicy } from "./lib/code-quality-policy.mjs";
import {
  adaptResponsibilityDiagnostics,
  assessPolicyResponsibilities,
} from "./lib/code-quality-responsibilities.mjs";
import { runnerIdentity, runNativePolicy } from "./lib/code-quality-runner.mjs";

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
]);

export function parsePolicyArguments(args, ci = process.env.CI === "true") {
  const options = { mode: "enforce", scope: "repository", json: false };
  const supplied = new Set();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (supplied.has(key)) throw new TypeError("invalid-arguments");
    supplied.add(key);
    if (key === "--json") options.json = true;
    else {
      applyPolicyOption(options, key, args[++index]);
    }
  }
  if (!["enforce", "census"].includes(options.mode)) throw new TypeError("invalid-mode");
  if (ci && (options.scope !== "repository" || options.mode !== "enforce"))
    throw new TypeError("partial-ci-verdict");
  return options;
}

function applyPolicyOption(options, key, value) {
  if (!["--mode", "--scope"].includes(key) || value === undefined || value.startsWith("--")) {
    throw new TypeError("invalid-arguments");
  }
  options[key.slice(2)] = value;
}

export async function executeCodeQualityPolicy(options, repositoryRoot = root) {
  const source = readFileSync(resolve(repositoryRoot, "scripts/code-quality-policy.json"));
  const policy = JSON.parse(source);
  const errors = validatePolicy(policy, readPreviousPolicies(repositoryRoot));
  if (errors.length > 0) throw new TypeError(errors[0]);
  const tools = runnerIdentity();
  const subject = await collectPolicySubject(repositoryRoot);
  const { inventory } = subject;
  const scope = selectPolicyScope(inventory.files, options.scope, process.env.CI === "true");
  validateActiveScopes(policy, inventory.files);
  const pack = collectPolicyPackages(repositoryRoot, inventory.packages);
  const scan = runNativePolicy(repositoryRoot, scope.files);
  const inventorySha256 = policyDigest(JSON.stringify(inventory));
  const rawAssessment = assessPolicyDiagnostics(scan.diagnostics, scope.files, policy);
  const responsibilities =
    policy.version === 2 ? assessPolicyResponsibilities(subject, policy, scope.files) : null;
  const assessed = responsibilities
    ? adaptResponsibilityDiagnostics(rawAssessment, responsibilities)
    : rawAssessment;
  await assertPolicySubjectCurrent(repositoryRoot, source, inventorySha256);
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
    ...assessed,
    inventory,
    pack,
    ...(responsibilities
      ? { responsibilities, enforcementOutcome: enforcementOutcome(assessed, responsibilities) }
      : {}),
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
    responsibilities && responsibilities.counts.qualified !== responsibilities.assessments.length;
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
    const report = await executeCodeQualityPolicy(options, repositoryRoot);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
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
