import { describe, expect, it } from "vitest";

import {
  loadExternalQualitySources,
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

  it("rejects non-blocking CodeRabbit review, stale-head review, or code mutation", () => {
    const weakened = sources.codeRabbitConfig
      .replace("request_changes_workflow: true", "request_changes_workflow: false")
      .replace(
        "override_requested_reviewers_only: true",
        "override_requested_reviewers_only: false",
      )
      .replace("auto_incremental_review: true", "auto_incremental_review: false")
      .replace("autofix:\n      enabled: false", "autofix:\n      enabled: true");
    expect(findings({ codeRabbitConfig: weakened })).toEqual(
      expect.arrayContaining([
        "CodeRabbit findings must block through review state",
        "CodeRabbit pre-merge failures must not be overridable by the pull-request author",
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
    const softened = `${sources.codspeedWorkflow}\ncontinue-on-error: true\nCODSPEED_TOKEN: secret`;
    expect(findings({ codspeedWorkflow: softened })).toEqual(
      expect.arrayContaining([
        "CodSpeed execution must not be softened with continue-on-error",
        "CodSpeed must not introduce a long-lived repository upload token",
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
      .replace('npm run check:semantic-duplication -- --changed-since "$base"', "true");
    expect(findings({ ciWorkflow: weakened })).toEqual(
      expect.arrayContaining([
        "Gitleaks output must remain fully redacted",
        "required ci must aggregate the secret scan",
        "required ci must run diff-scoped semantic duplication",
      ]),
    );
  });
});
