import { describe, expect, it, vi } from "vitest";

import {
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
        "bench:codspeed must execute the repository-owned benchmark entry point",
        "check:external-quality-config script is missing or redirected",
        "check:codspeed-policy script is missing or redirected",
        "check:greptile-findings script is missing or redirected",
        "semantic duplication must fail on every changed clone group",
      ]),
    );
  });

  it("rejects non-blocking CodeRabbit review, stale-head review, or code mutation", () => {
    const weakened = sources.codeRabbitConfig
      .replace("request_changes_workflow: true", "request_changes_workflow: false")
      .replace(
        "override_requested_reviewers_only: true",
        "override_requested_reviewers_only: false",
      )
      .replace('title:\n      mode: "error"', 'title:\n      mode: "warning"')
      .replace('description:\n      mode: "error"', 'description:\n      mode: "warning"')
      .replace("auto_incremental_review: true", "auto_incremental_review: false")
      .replace("autofix:\n      enabled: false", "autofix:\n      enabled: true");
    expect(findings({ codeRabbitConfig: weakened })).toEqual(
      expect.arrayContaining([
        "CodeRabbit findings must block through review state",
        "CodeRabbit pre-merge failures must not be overridable by the pull-request author",
        "CodeRabbit must fail malformed pull-request titles",
        "CodeRabbit must fail incomplete pull-request descriptions",
        "CodeRabbit must review pull request updates",
        "CodeRabbit autofix mutation must remain disabled",
      ]),
    );
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
      .replace("ref: ${{ github.event.pull_request.base.sha }}", "ref: ${{ github.head_ref }}")
      .replace("contents: read", "contents: write")
      .replace("run: test -f scripts/check-codspeed-policy.mjs", "run: npm test");
    expect(findings({ codspeedPolicyWorkflow: untrusted })).toEqual(
      expect.arrayContaining([
        "CodSpeed policy must check out only the immutable base",
        "CodSpeed policy must grant only read access to repository contents",
        "CodSpeed policy must fail closed when the base gate is unavailable",
        "CodSpeed policy must never grant writes or execute pull-request code",
      ]),
    );
  });

  it("rejects a second checkout in the base-trusted CodSpeed policy workflow", () => {
    const secondCheckout = `${sources.codspeedPolicyWorkflow}\n- uses: actions/checkout@deadbeef`;
    expect(findings({ codspeedPolicyWorkflow: secondCheckout })).toContain(
      "CodSpeed policy must perform exactly one base checkout",
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
    config.fixWithAI = true;
    config.excludeAuthors = ["dependabot[bot]"];
    expect(findings({ greptileConfig: JSON.stringify(config) })).toEqual(
      expect.arrayContaining([
        "Greptile must review every new head",
        "Greptile must emit an observable status check",
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
        "Greptile fileChangeLimit must remain 1000",
        "Greptile draft auto-review must remain disabled",
        "Greptile must not mutate Keiko's load-bearing pull request template",
        "Greptile must update one summary instead of creating comment churn",
        "Greptile rules must be JSON objects",
      ]),
    );
  });

  it("rejects malformed Greptile context entries without reflecting their values", () => {
    expect(findings({ greptileFiles: '{"files":[null]}' })).toContain(
      ".greptile/files.json entries must be JSON objects",
    );
    expect(findings({ greptileFiles: "{}" })).toContain(
      ".greptile/files.json must carry a files array",
    );
  });

  it("rejects a Greptile settlement workflow that executes pull-request code", () => {
    const untrusted = sources.greptileWorkflow
      .replace(
        "ref: ${{ github.event.pull_request.base.sha }}",
        "ref: ${{ github.event.pull_request.head.sha }}",
      )
      .replace("pull-requests: read", "pull-requests: write");
    expect(findings({ greptileWorkflow: untrusted })).toEqual(
      expect.arrayContaining([
        "Greptile settlement must check out only the immutable base",
        "Greptile settlement must never grant writes or execute pull-request code",
      ]),
    );
  });

  it("rejects alternate pull-request refs and a missing base-owned Greptile gate", () => {
    const untrusted = sources.greptileWorkflow
      .replace("ref: ${{ github.event.pull_request.base.sha }}", "ref: ${{ github.head_ref }}")
      .replace("run: test -f scripts/check-greptile-findings.mjs", "run: true");
    expect(findings({ greptileWorkflow: untrusted })).toEqual(
      expect.arrayContaining([
        "Greptile settlement must check out only the immutable base",
        "Greptile settlement must never grant writes or execute pull-request code",
        "Greptile settlement must fail closed when the base gate is unavailable",
      ]),
    );
  });

  it("rejects missing reviewer context and missing required-ci wiring", () => {
    const withoutGate = sources.ciWorkflow.replace("npm run check:external-quality-config", "");
    const pathExists = (path) => !path.endsWith("ADR-0019-modular-package-architecture.md");
    expect(findings({ ciWorkflow: withoutGate }, pathExists)).toEqual(
      expect.arrayContaining([
        "required ci must execute check:external-quality-config",
        "Greptile context path does not exist: docs/adr/ADR-0019-modular-package-architecture.md",
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
