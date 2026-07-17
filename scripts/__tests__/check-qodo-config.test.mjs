import { describe, expect, it } from "vitest";
import { loadQodoSources, validateQodoSources } from "../check-qodo-config.mjs";

const configText = [
  "[pr_reviewer]",
  "approve_pr_on_self_review = false",
  "auto_approve_for_no_suggestions = false",
  'extra_instructions = """',
  "AGENTS.md CONTRIBUTING.md docs/qa/keiko-for-quality.md docs/qa/qodo-review-policy.md",
  "docs/adr/ADR-0129-product-wide-authority-and-autonomy-model.md",
  "docs/adr/ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md",
  "Assume every pull request targeting `dev` is a large, completed-epic integration PR",
  "exact current head",
  "direct app-bound required checks",
  "unreviewed files",
  "every finding at every severity",
  "failure-first regression",
  "package-surface",
  "Linux-authoritative release evidence",
  "Qodo is advisory",
  "Do not block merges, auto-approve",
  "Never force-push, push directly to `dev`",
  '"""',
].join("\n");

function validSources() {
  return { bestPractices: "# Keiko best practices\n", config: configText };
}

describe("Qodo configuration gate", () => {
  it("accepts the checked-in Qodo configuration", () => {
    expect(validateQodoSources(loadQodoSources())).toEqual([]);
  });

  it("accepts a minimal valid fixture", () => {
    expect(validateQodoSources(validSources())).toEqual([]);
  });

  it("fails closed when the Qodo config files are absent", () => {
    expect(validateQodoSources({ bestPractices: undefined, config: undefined })).toEqual(
      expect.arrayContaining([".pr_agent.toml is missing", "best_practices.md is missing"]),
    );
  });

  it("rejects any enabled auto-approval switch", () => {
    const sources = validSources();
    sources.config = `${sources.config}\nenable_auto_approval = true\n`;
    expect(validateQodoSources(sources)).toContain(
      "Qodo config must not enable enable_auto_approval; Qodo has no merge authority",
    );
  });

  it("requires the no-merge-authority switch to be explicit", () => {
    const sources = validSources();
    sources.config = sources.config.replace("approve_pr_on_self_review = false\n", "");
    expect(validateQodoSources(sources)).toContain(
      "Qodo config must explicitly set approve_pr_on_self_review = false",
    );
  });

  it("rejects missing governance references and core instructions", () => {
    const sources = {
      bestPractices: "empty",
      config: "[pr_reviewer]\napprove_pr_on_self_review = false\n",
    };
    expect(validateQodoSources(sources)).toEqual(
      expect.arrayContaining([
        "Qodo review guidance must reference AGENTS.md",
        "Qodo review guidance must include: exact current head",
        "Qodo review guidance must include: Do not block merges, auto-approve",
      ]),
    );
  });

  it("rejects a best_practices file over the length ceiling", () => {
    const sources = validSources();
    sources.bestPractices = Array.from({ length: 801 }, () => "line").join("\n");
    expect(validateQodoSources(sources)).toContain("best_practices.md exceeds 800 lines");
  });
});
