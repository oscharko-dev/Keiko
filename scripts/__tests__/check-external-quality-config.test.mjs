import { describe, expect, it, vi } from "vitest";

import {
  loadExternalQualitySources,
  main,
  validateExternalQualitySources,
} from "../check-external-quality-config.mjs";

const sources = loadExternalQualitySources();

function findings(overrides = {}) {
  return validateExternalQualitySources({ ...sources, ...overrides });
}

describe("external quality integration configuration", () => {
  it("accepts the repository-owned CodSpeed and CodeRabbit configuration", () => {
    expect(validateExternalQualitySources(sources)).toEqual([]);
  });

  it.each([
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
        "semantic duplication must fail on every changed clone group",
      ]),
    );
  });

  it("rejects quota-dependent CodeRabbit authority, stale-head review, or code mutation", () => {
    const weakened = sources.codeRabbitConfig
      .replace("request_changes_workflow: false", "request_changes_workflow: true")
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
      .replace("autofix:\n      enabled: false", "autofix:\n      enabled: true");
    expect(findings({ codeRabbitConfig: weakened })).toEqual(
      expect.arrayContaining([
        "CodeRabbit must not regain quota-dependent review authority",
        "CodeRabbit must not emit a quota-dependent merge status",
        "CodeRabbit failure status must remain advisory",
        "CodeRabbit review state must remain advisory",
        "CodeRabbit pre-merge failures must not be overridable by the pull-request author",
        "CodeRabbit title feedback must remain advisory",
        "CodeRabbit description feedback must remain advisory",
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

  it("rejects missing required-ci wiring", () => {
    const withoutGate = sources.ciWorkflow.replace("npm run check:external-quality-config", "");
    expect(findings({ ciWorkflow: withoutGate })).toContain(
      "required ci must execute check:external-quality-config",
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
    expect(main(sources, log, error)).toBe(0);
    expect(log).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();

    expect(main({ ...sources, packageJson: "" }, log, error)).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "external-quality-config: packageJson must contain a valid JSON object",
    );
  });
});
