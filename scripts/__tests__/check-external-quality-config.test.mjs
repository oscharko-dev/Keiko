import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  findUnreviewedGreptilePaths,
  isRegularRepositoryFile,
  loadExternalQualitySources,
  main,
  validateExternalQualitySources,
} from "../check-external-quality-config.mjs";

const sources = loadExternalQualitySources();

function findings(overrides = {}, pathExists = () => true) {
  return validateExternalQualitySources({ ...sources, ...overrides }, pathExists);
}

describe("external quality integration configuration", () => {
  it("accepts the repository-owned CodSpeed, CodeRabbit, and Greptile configuration", () => {
    expect(validateExternalQualitySources(sources)).toEqual([]);
  });

  it.each([
    ["greptileConfig", ""],
    ["greptileConfig", '{"rules": ['],
    ["greptileFiles", ""],
    ["greptileFiles", '{"files": ['],
    ["packageJson", ""],
    ["packageJson", '{"devDependencies":'],
  ])("returns a redacted finding for malformed %s input", (key, value) => {
    expect(() => findings({ [key]: value })).not.toThrow();
    expect(findings({ [key]: value })).toContain(`${key} must contain a valid JSON object`);
  });

  it("fails closed when the package manifest omits dependency and script objects", () => {
    expect(findings({ packageJson: "{}" })).toEqual(
      expect.arrayContaining([
        "fallow must be pinned to 2.104.0",
        "yaml must be pinned to 2.9.0 for semantic reviewer-policy validation",
        "bench:codspeed must execute the repository-owned benchmark entry point",
        "check:external-quality-config script is missing or redirected",
        "check:review-bot-suppression script is missing or redirected",
        "check:codspeed-policy script is missing or redirected",
        "semantic duplication must fail on every changed clone group",
      ]),
    );
  });

  it("rejects disabled CodeRabbit settlement, stale-head review, or code mutation", () => {
    const weakened = sources.codeRabbitConfig
      .replace("request_changes_workflow: true", "request_changes_workflow: false")
      .replace("commit_status: false", "commit_status: true")
      .replace("fail_commit_status: false", "fail_commit_status: true")
      .replace("review_status: false", "review_status: true")
      .replace(
        "override_requested_reviewers_only: true",
        "override_requested_reviewers_only: false",
      )
      .replace('title:\n      mode: "warning"', 'title:\n      mode: "error"')
      .replace('description:\n      mode: "warning"', 'description:\n      mode: "error"')
      .replace("auto_incremental_review: true", "auto_incremental_review: false")
      .replace('base_branches:\n      - "dev"', "base_branches: []")
      .replace("autofix:\n      enabled: false", "autofix:\n      enabled: true");
    expect(findings({ codeRabbitConfig: weakened })).toEqual(
      expect.arrayContaining([
        "CodeRabbit findings must request changes until their conversations are resolved",
        "CodeRabbit must not emit a quota-dependent merge status",
        "CodeRabbit failure status must remain advisory",
        "CodeRabbit review state must remain advisory",
        "CodeRabbit pre-merge failures must not be overridable by the pull-request author",
        "CodeRabbit title feedback must remain advisory",
        "CodeRabbit description feedback must remain advisory",
        "CodeRabbit must review pull request updates",
        "CodeRabbit must review every pull request targeting dev",
        "CodeRabbit autofix mutation must remain disabled",
      ]),
    );
  });

  it("parses CodeRabbit YAML so decoy text cannot hide disabled automatic review", () => {
    const disabled = `${sources.codeRabbitConfig.replace(
      "  auto_review:\n    enabled: true",
      "  auto_review:\n    enabled: false",
    )}\nreview_policy_note: |\n  auto_review:\n    enabled: true\n`;
    expect(findings({ codeRabbitConfig: disabled })).toEqual(
      expect.arrayContaining([
        "CodeRabbit automatic review must remain enabled",
        "CodeRabbit semantic review policy must match the reviewed configuration",
      ]),
    );
  });

  it("rejects malformed or aliased CodeRabbit YAML", () => {
    expect(findings({ codeRabbitConfig: "reviews: [" })).toContain(
      "codeRabbitConfig must contain a valid alias-free YAML object",
    );
    expect(
      findings({ codeRabbitConfig: "defaults: &defaults {}\nreviews: *defaults\n" }),
    ).toContain("codeRabbitConfig must contain a valid alias-free YAML object");
  });

  it("rejects a mutable CodSpeed action ref or non-simulation mode", () => {
    const mutable = sources.codspeedWorkflow
      .replace(/CodSpeedHQ\/action@[0-9a-f]{40} # v5\.0\.1/u, "CodSpeedHQ/action@v5")
      .replace("mode: simulation", "mode: walltime");
    expect(findings({ codspeedWorkflow: mutable })).toEqual(
      expect.arrayContaining([
        "CodSpeed action must use the reviewed immutable pin",
        "CodSpeed must use deterministic CPU simulation",
      ]),
    );
  });

  it("rejects a softened or token-authenticated benchmark workflow", () => {
    const softened = `${sources.codspeedWorkflow}\ncontinue-on-error: true\nCODSPEED_TOKEN: secret\nid-token: write`;
    expect(findings({ codspeedWorkflow: softened })).toEqual(
      expect.arrayContaining([
        "CodSpeed execution must not be softened with continue-on-error",
        "CodSpeed must not introduce a long-lived repository upload token",
        "CodSpeed pull-request benchmarks must not receive an OIDC credential grant",
      ]),
    );
  });

  it("rejects a CodSpeed checkout that is not bound to the pull-request head", () => {
    const mergeCommit = sources.codspeedWorkflow.replace(
      "ref: ${{ github.event.pull_request.head.sha || github.sha }}",
      "ref: ${{ github.sha }}",
    );
    expect(findings({ codspeedWorkflow: mergeCommit })).toContain(
      "CodSpeed checkout must bind pull requests to the exact head",
    );
  });

  it("rejects a CodSpeed policy workflow that executes pull-request code", () => {
    const untrusted = sources.codspeedPolicyWorkflow
      .replace(
        "QUALITY_BASE_SHA: ${{ github.event.pull_request.base.sha }}",
        "QUALITY_BASE_SHA: ${{ github.head_ref }}",
      )
      .replace("contents: read", "contents: write")
      .replace("run: test -f scripts/check-codspeed-policy.mjs", "run: npm test");
    expect(findings({ codspeedPolicyWorkflow: untrusted })).toEqual(
      expect.arrayContaining([
        "CodSpeed policy must bind execution to the immutable protected base",
        "CodSpeed policy must grant only read access to repository contents",
        "CodSpeed policy must fail closed when the base gate is unavailable",
        "CodSpeed policy must never grant writes or execute pull-request code",
      ]),
    );
  });

  it("rejects a checkout action in the base-trusted CodSpeed policy workflow", () => {
    const secondCheckout = `${sources.codspeedPolicyWorkflow}\n- uses: actions/checkout@deadbeef`;
    expect(findings({ codspeedPolicyWorkflow: secondCheckout })).toContain(
      "CodSpeed policy must never grant writes or execute pull-request code",
    );
  });

  it("rejects a CodSpeed policy workflow without the governed runtime pin", () => {
    const unpinned = sources.codspeedPolicyWorkflow.replace(
      "run: node scripts/check-runtime-toolchain.mjs --exact",
      "run: node --version",
    );
    expect(findings({ codspeedPolicyWorkflow: unpinned })).toContain(
      "CodSpeed policy must verify the governed Node.js and npm toolchain",
    );
  });

  it("rejects drift from the live CodSpeed threshold and failing-check policy", () => {
    const policy = JSON.parse(sources.codspeedPolicy);
    policy.regressionThresholdPercent = 10;
    policy.failOnRegression = false;
    policy.pullRequestReport = "on-change";
    expect(findings({ codspeedPolicy: JSON.stringify(policy) })).toEqual(
      expect.arrayContaining([
        "CodSpeed regression threshold must remain 5%",
        "CodSpeed regressions must fail their status check",
        "CodSpeed must report every pull-request head",
      ]),
    );
  });

  it("rejects plugin execution or an incomplete CodSpeed CLI manifest", () => {
    const pluginExecution = `${sources.codspeedWorkflow}\n          run: npm run bench:codspeed`;
    const incompleteManifest = sources.codspeedConfig.replace(
      "    exec: node benchmarks/codspeed.mjs editor-text-edits",
      "",
    );
    expect(
      findings({ codspeedWorkflow: pluginExecution, codspeedConfig: incompleteManifest }),
    ).toEqual(
      expect.arrayContaining([
        "CodSpeed action must discover codspeed.yml instead of a framework plugin run",
        "CodSpeed CLI manifest is missing node benchmarks/codspeed.mjs editor-text-edits",
      ]),
    );
  });

  it("rejects Greptile drift that omits current-head or status evidence", () => {
    const config = JSON.parse(sources.greptileConfig);
    config.triggerOnUpdates = false;
    config.statusCheck = false;
    config.statusCommentsEnabled = true;
    config.sequenceDiagramSection.included = true;
    config.fixWithAI = true;
    config.excludeAuthors = ["dependabot[bot]"];
    expect(findings({ greptileConfig: JSON.stringify(config) })).toEqual(
      expect.arrayContaining([
        "Greptile must review every new head",
        "Greptile must emit an observable status check",
        "Greptile status comments must remain disabled",
        "Greptile sequence diagrams must remain disabled",
        "Greptile must not write pull-request code",
        "Greptile must not omit bot-authored dev pull requests by configuration",
      ]),
    );
  });

  it("rejects Greptile scope, behavior, and rule drift", () => {
    const config = JSON.parse(sources.greptileConfig);
    config.strictness = 1;
    config.commentTypes = ["style"];
    config.includeBranches = ["main"];
    config.fileChangeLimit = 999;
    config.triggerOnDrafts = true;
    config.shouldUpdateDescription = true;
    config.updateExistingSummaryComment = false;
    config.rules = [null];
    expect(findings({ greptileConfig: JSON.stringify(config) })).toEqual(
      expect.arrayContaining([
        "Greptile strictness must remain at high-signal level 2",
        "Greptile must leave deterministic style/info findings to repository gates",
        "Greptile must review pull requests targeting dev",
        "Greptile fileChangeLimit must remain 500",
        "Greptile draft auto-review must remain disabled",
        "Greptile must not mutate Keiko's load-bearing pull request template",
        "Greptile must update one summary instead of creating comment churn",
        "Greptile rules must be JSON objects",
      ]),
    );
  });

  it.each([
    ["automatic skip", (config) => (config.skipReview = "AUTOMATIC")],
    ["summary-only mode", (config) => (config.updateSummaryOnly = true)],
    ["global ignore", (config) => (config.ignorePatterns = "**/*")],
    ["missing instructions", (config) => (config.instructions = "")],
    [
      "replacement rules",
      (config) =>
        (config.rules = [{ id: "noop", rule: "Leave a friendly comment.", severity: "high" }]),
    ],
  ])("rejects Greptile semantic suppression through %s", (_label, mutate) => {
    const config = JSON.parse(sources.greptileConfig);
    mutate(config);
    expect(findings({ greptileConfig: JSON.stringify(config) })).toContain(
      "Greptile semantic review policy must match the reviewed configuration",
    );
  });

  it("rejects unreviewed and nested Greptile files because provider rules cascade", () => {
    expect(
      findings({ unreviewedGreptilePaths: ["packages/example/.greptile/rules.md"] }),
    ).toContain(
      "Unreviewed Greptile files and nested controls are prohibited because provider rules cascade",
    );
  });

  it("discovers tracked ignored, root, nested, and symlink controls", () => {
    const repository = mkdtempSync(join(tmpdir(), "keiko-greptile-inventory-"));
    mkdirSync(join(repository, ".greptile"));
    mkdirSync(join(repository, "packages", "example", ".greptile"), { recursive: true });
    mkdirSync(join(repository, "node_modules", "tracked", ".greptile"), { recursive: true });
    writeFileSync(join(repository, ".gitignore"), "node_modules/\n");
    writeFileSync(join(repository, ".greptile", "config.json"), "{}");
    writeFileSync(join(repository, ".greptile", "files.json"), "{}");
    writeFileSync(join(repository, ".greptile", "rules.md"), "unreviewed");
    writeFileSync(join(repository, "packages", "example", ".greptile", "rules.md"), "nested");
    writeFileSync(
      join(repository, "node_modules", "tracked", ".greptile", "rules.md"),
      "tracked ignored control",
    );
    symlinkSync("rules.md", join(repository, ".greptile", "linked-rules.md"));
    execFileSync("git", ["init", "--quiet"], { cwd: repository });
    execFileSync("git", ["add", "--force", "node_modules/tracked/.greptile/rules.md"], {
      cwd: repository,
    });
    expect(findUnreviewedGreptilePaths(repository).sort()).toEqual([
      ".greptile/linked-rules.md",
      ".greptile/rules.md",
      "node_modules/tracked/.greptile/rules.md",
      "packages/example/.greptile/rules.md",
    ]);
    rmSync(repository, { recursive: true, force: true });
  });

  it("accepts only regular repository-bounded reviewer context files", () => {
    const repository = mkdtempSync(join(tmpdir(), "keiko-greptile-context-"));
    writeFileSync(join(repository, "governance.md"), "reviewed");
    mkdirSync(join(repository, "directory.md"));
    symlinkSync("governance.md", join(repository, "linked.md"));
    expect(isRegularRepositoryFile(repository, "governance.md")).toBe(true);
    expect(isRegularRepositoryFile(repository, "directory.md")).toBe(false);
    expect(isRegularRepositoryFile(repository, "linked.md")).toBe(false);
    expect(isRegularRepositoryFile(repository, "../outside.md")).toBe(false);
    rmSync(repository, { recursive: true, force: true });
  });

  it("rejects malformed Greptile context entries without reflecting their values", () => {
    expect(findings({ greptileFiles: '{"files":[null]}' })).toContain(
      ".greptile/files.json entries must be JSON objects",
    );
    expect(findings({ greptileFiles: "{}" })).toContain(
      ".greptile/files.json must carry a files array",
    );
    const traversal = "../../../../../../../sensitive-host-path";
    const context = JSON.parse(sources.greptileFiles);
    context.files.push({ path: traversal, description: "untrusted" });
    const problems = findings({ greptileFiles: JSON.stringify(context) });
    expect(problems).toContain("Greptile context entry 10 must name an existing repository path");
    expect(problems.join("\n")).not.toContain(traversal);
  });

  it("rejects missing reviewer context and missing required-ci wiring", () => {
    const withoutGate = sources.ciWorkflow
      .replace("types: [opened, reopened, synchronize, ready_for_review, edited]", "")
      .replace("npm run check:external-quality-config", "")
      .replace("npm run check:review-bot-suppression", "");
    const pathExists = (path) => !path.endsWith("ADR-0019-modular-package-architecture.md");
    expect(findings({ ciWorkflow: withoutGate }, pathExists)).toEqual(
      expect.arrayContaining([
        "required ci must rerun when pull-request metadata changes",
        "required ci must execute check:external-quality-config",
        "required ci must reject pull-request metadata that suppresses review bots",
        "Greptile context entry 3 must name an existing repository path",
      ]),
    );
  });

  it("rejects weakened secret or semantic-duplication wiring", () => {
    const weakened = sources.ciWorkflow
      .replace("--redact=100", "--redact=0")
      .replace("      - secret-scan", "      # secret scan removed")
      .replace('npm run check:semantic-duplication -- --changed-since "$QUALITY_BASE_SHA"', "true")
      .replace('node scripts/resolve-quality-range.mjs >> "$GITHUB_OUTPUT"', "true");
    expect(findings({ ciWorkflow: weakened })).toEqual(
      expect.arrayContaining([
        "Gitleaks output must remain fully redacted",
        "required ci must aggregate the secret scan",
        "required ci must run diff-scoped semantic duplication",
        "quality gates must share exactly two immutable-range resolver calls",
      ]),
    );
  });

  it("returns a testable CLI status and redacted messages", () => {
    const log = vi.fn();
    const error = vi.fn();
    expect(main(sources, () => true, log, error)).toBe(0);
    expect(log).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();

    expect(main({ ...sources, greptileConfig: "" }, () => true, log, error)).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "external-quality-config: greptileConfig must contain a valid JSON object",
    );
  });
});
