import { describe, expect, it, vi } from "vitest";

import {
  loadExternalQualitySources,
  main,
  semanticDigest,
  validateExternalQualitySources,
} from "../check-external-quality-config.mjs";

const sources = loadExternalQualitySources();

function findings(overrides = {}) {
  return validateExternalQualitySources({ ...sources, ...overrides });
}

describe("external quality integration configuration", () => {
  it("accepts CodeRabbit and the deterministic repository gates", () => {
    expect(validateExternalQualitySources(sources)).toEqual([]);
  });

  it("canonicalizes policy keys with locale-independent code-unit ordering", () => {
    const expected = "896b8dd27b9b539d56c30c96acce8910a2293d7bef3fc3ef87195bc2eb778073";
    expect(semanticDigest({ ä: 1, z: 2 })).toBe(expected);
    expect(semanticDigest({ z: 2, ä: 1 })).toBe(expected);
  });

  it.each([
    ["codeRabbitConfig", ""],
    ["codeRabbitConfig", "reviews: ["],
    ["packageJson", ""],
    ["packageJson", '{"devDependencies":'],
  ])("returns a redacted finding for malformed %s input", (key, value) => {
    expect(() => findings({ [key]: value })).not.toThrow();
    expect(findings({ [key]: value })[0]).toMatch(/must contain a valid/iu);
    if (value.length > 0) expect(findings({ [key]: value }).join("\n")).not.toContain(value);
  });

  it("rejects disabled CodeRabbit settlement, stale-head review, or code mutation", () => {
    const weakened = sources.codeRabbitConfig
      .replace("request_changes_workflow: true", "request_changes_workflow: false")
      .replace("auto_incremental_review: true", "auto_incremental_review: false")
      .replace("ignore_usernames: []", 'ignore_usernames: ["bot"]')
      .replace("autofix:\n      enabled: false", "autofix:\n      enabled: true");
    expect(findings({ codeRabbitConfig: weakened })).toEqual(
      expect.arrayContaining([
        "CodeRabbit findings must request changes until their conversations are resolved",
        "CodeRabbit must review pull request updates",
        "CodeRabbit must not omit bot-authored pull requests",
        "CodeRabbit autofix mutation must remain disabled",
        "CodeRabbit semantic review policy must match the reviewed configuration",
      ]),
    );
  });

  it("rejects aliases and semantically changed CodeRabbit policy", () => {
    expect(findings({ codeRabbitConfig: "base: &base {}\ncopy: *base\n" })).toContain(
      "codeRabbitConfig must contain a valid alias-free YAML object",
    );
    const changed = `${sources.codeRabbitConfig}\nunknown_policy: true\n`;
    expect(findings({ codeRabbitConfig: changed })).toContain(
      "CodeRabbit semantic review policy must match the reviewed configuration",
    );
  });

  it("fails closed when package gate commands or dependencies drift", () => {
    const parsed = JSON.parse(sources.packageJson);
    delete parsed.devDependencies.fallow;
    delete parsed.devDependencies.yaml;
    delete parsed.scripts["check:external-quality-config"];
    delete parsed.scripts["check:review-bot-suppression"];
    parsed.scripts["check:semantic-duplication"] = "true";
    expect(findings({ packageJson: JSON.stringify(parsed) })).toEqual(
      expect.arrayContaining([
        "fallow must be pinned to 3.9.1",
        "yaml must be pinned to 2.9.0 for semantic reviewer-policy validation",
        "check:external-quality-config script is missing or redirected",
        "check:review-bot-suppression script is missing or redirected",
        "semantic duplication must fail on every changed clone group",
      ]),
    );
  });

  it("fails closed when required CI stops aggregating deterministic gates", () => {
    const weakened = sources.ciWorkflow
      .replace(
        "types: [opened, reopened, synchronize, ready_for_review, edited]",
        "types: [opened, reopened, synchronize, ready_for_review]",
      )
      .replace("npm run check:external-quality-config", "node --version")
      .replace("npm run check:review-bot-suppression", "node --version")
      .replace("      - secret-scan", "")
      .replace("      - semantic-duplication", "");
    expect(findings({ ciWorkflow: weakened })).toEqual(
      expect.arrayContaining([
        "required ci must rerun when pull-request metadata changes",
        "required ci must aggregate the secret scan",
        "required ci must aggregate semantic duplication",
        "required ci must execute check:external-quality-config",
        "required ci must reject pull-request metadata that suppresses CodeRabbit",
      ]),
    );
  });

  it("fails closed when redaction or the immutable quality range drifts", () => {
    // Every Gitleaks invocation must be redacted, so dropping the flag from ANY ONE of them has to
    // be caught -- `replaceAll` would only prove the all-or-nothing case and would pass even while
    // a single unredacted call remained.
    const redactionSites = sources.ciWorkflow.split("--redact=100").length - 1;
    expect(redactionSites).toBeGreaterThan(1);
    for (let site = 0; site < redactionSites; site += 1) {
      let seen = -1;
      const withoutOne = sources.ciWorkflow.replace(/--redact=100 /gu, (match) => {
        seen += 1;
        return seen === site ? "" : match;
      });
      expect(findings({ ciWorkflow: withoutOne })).toContain(
        "Gitleaks output must remain fully redacted",
      );
    }
    // A workflow with no Gitleaks scan at all must fail closed too: counting alone would read
    // "0 of 0 redacted" as satisfied, silently accepting a secret scan that never runs. The probe
    // removes the invocations but LEAVES a `--redact=100` occurrence behind, so a guard that only
    // looks for that string still sees it -- the finding can then come from the count and nothing
    // else, which is what makes this case exercise the new behaviour rather than the old one.
    const noScans = sources.ciWorkflow
      .replaceAll('"${RUNNER_TEMP}/gitleaks" git --redact=100 ', "")
      .concat("\n# residual --redact=100 marker, no scan invocation\n");
    expect(noScans).toContain("--redact=100");
    expect(findings({ ciWorkflow: noScans })).toContain(
      "Gitleaks output must remain fully redacted",
    );
    const singleResolver = sources.ciWorkflow.replace(
      'node scripts/resolve-quality-range.mjs >> "$GITHUB_OUTPUT"',
      "true",
    );
    expect(findings({ ciWorkflow: singleResolver })).toContain(
      "quality gates must share exactly two immutable-range resolver calls",
    );
  });

  it("counts commented Gitleaks invocations symmetrically, so a comment cannot mask a live invocation", () => {
    // The two counters cannot be balanced against each other: the redacted pattern extends the scan
    // pattern, so every redacted match is also a scan match and `redactedScans <= scans` always
    // holds. A commented invocation adds one to BOTH counters; a live unredacted call adds one to
    // `scans` alone and breaks the equality the guard requires. This pins the decoy a reviewer of
    // #3463 expected to slip through: a commented redacted call next to a live unredacted one.
    // `replace` with a string pattern is first-occurrence on purpose -- exactly ONE live call loses
    // the flag, which is the case a `replaceAll` probe cannot produce.
    const decoy = sources.ciWorkflow
      .replace('"${RUNNER_TEMP}/gitleaks" git --redact=100 ', '"${RUNNER_TEMP}/gitleaks" git ')
      .concat(
        '\n        # "${RUNNER_TEMP}/gitleaks" git --redact=100 --no-banner --timeout=120 .\n',
      );
    expect(findings({ ciWorkflow: decoy })).toContain("Gitleaks output must remain fully redacted");
    // The same comment on an otherwise untouched workflow is inert: counted on both sides, it
    // neither raises a finding nor suppresses one.
    const commentOnly = sources.ciWorkflow.concat(
      '\n        # "${RUNNER_TEMP}/gitleaks" git --redact=100 --no-banner --timeout=120 .\n',
    );
    expect(findings({ ciWorkflow: commentOnly })).not.toContain(
      "Gitleaks output must remain fully redacted",
    );
  });

  it("returns testable, redacted CLI outcomes", () => {
    const log = vi.fn();
    const error = vi.fn();
    expect(main(sources, log, error)).toBe(0);
    expect(log).toHaveBeenCalledWith(
      "external-quality-config: PASS — CodeRabbit and deterministic repository gates are bound",
    );
    expect(error).not.toHaveBeenCalled();

    expect(main({ ...sources, codeRabbitConfig: "secret-invalid" }, log, error)).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "external-quality-config: codeRabbitConfig must contain a valid alias-free YAML object",
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret-invalid");
  });
});
