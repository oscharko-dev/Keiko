import { describe, expect, it } from "vitest";
import { loadGitarSources, validateGitarSources } from "../check-gitar-config.mjs";

function validSources() {
  return {
    approval:
      "Only auto-approve the exact current head after every finding at every severity is resolved. Never auto-approve incomplete evidence. The direct app-bound required checks remain required.",
    reviews: [
      {
        name: "00-governance-and-delivery.md",
        source:
          "@AGENTS.md\n@CONTRIBUTING.md\n@docs/qa/keiko-for-quality.md\n@docs/qa/gitar-review-policy.md\n@docs/adr/ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md\nAssume every pull request targeting `dev` is a large, completed-epic integration PR",
      },
      { name: "10-security-and-trust-boundaries.md", source: "security" },
      { name: "20-architecture-quality-and-evidence.md", source: "quality" },
    ],
    rules: [
      "architecture-and-public-surface.md",
      "governance-and-delivery.md",
      "security-boundary-review.md",
      "ui-and-release-evidence.md",
      "verification-and-coverage.md",
    ].map((name) => {
      const actions =
        name === "governance-and-delivery.md"
          ? "Enable Auto-Apply and never unblock, force-push, push to dev, or bypass direct required checks"
          : name === "verification-and-coverage.md"
            ? "Auto-apply owning-layer fixes"
            : "Post a comment with a checklist";
      return {
        name,
        source: [
          "---",
          'title: "Rule"',
          'description: "Description"',
          'when: "Condition"',
          `actions: "${actions}"`,
          "---",
        ].join("\n"),
      };
    }),
  };
}

describe("Gitar configuration gate", () => {
  it("accepts the checked-in Keiko Pro configuration", () => {
    expect(validateGitarSources(loadGitarSources())).toEqual([]);
  });

  it("accepts the minimal valid contract fixture", () => {
    expect(validateGitarSources(validSources())).toEqual([]);
  });

  it("rejects extra rules and mutating rule actions", () => {
    const sources = validSources();
    sources.rules.push({
      name: "sixth-rule.md",
      source: [
        "---",
        'title: "Mutation"',
        'description: "Description"',
        'when: "Condition"',
        'actions: "Merge and push the change"',
        "---",
      ].join("\n"),
    });

    expect(validateGitarSources(sources)).toEqual(
      expect.arrayContaining([
        "Gitar rules has unexpected file sixth-rule.md",
        "Gitar Pro supports at most five custom rules",
        "sixth-rule.md must start its action with Post a comment",
      ]),
    );
  });

  it("rejects incomplete rules, review context, and approval policy", () => {
    const sources = validSources();
    sources.approval = "Approve everything.";
    sources.reviews[0].source = "no includes";
    sources.rules[0].source = "no frontmatter";

    expect(validateGitarSources(sources)).toEqual(
      expect.arrayContaining([
        "architecture-and-public-surface.md has no valid YAML frontmatter",
        "Gitar review instructions must include @AGENTS.md",
        "Gitar review instructions must treat every dev PR as a large completed-epic integration PR",
        "Gitar auto-approve criteria must define a positive allowlist",
        "Gitar auto-approve criteria must define explicit exclusions",
        "Gitar auto-approve criteria must require exact current head",
        "Gitar auto-approve criteria must require every finding at every severity",
        "Gitar auto-approve criteria must require direct app-bound required checks",
      ]),
    );
  });

  it("rejects missing fields and external integrations in valid frontmatter", () => {
    const sources = validSources();
    sources.rules[0].source = [
      "---",
      'title: "Integrated rule"',
      'description: "Description"',
      'actions: "Post a comment with a checklist"',
      'integrations: ["jira"]',
      "---",
    ].join("\n");

    expect(validateGitarSources(sources)).toEqual(
      expect.arrayContaining([
        "architecture-and-public-surface.md is missing frontmatter field when",
        "architecture-and-public-surface.md must not require an integration",
      ]),
    );
  });
});
