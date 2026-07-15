import { describe, expect, it } from "vitest";
import { loadGitarSources, validateGitarSources } from "../check-gitar-config.mjs";

const completeReviewSource = [
  "@AGENTS.md",
  "@CONTRIBUTING.md",
  "@docs/qa/keiko-for-quality.md",
  "@docs/qa/gitar-review-policy.md",
  "@docs/adr/ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md",
  "Assume every pull request targeting `dev` is a large, completed-epic integration PR",
  "exact current head",
  "direct app-bound required checks",
  "unreviewed files",
  "every finding at every severity",
  "failure-first regression",
  "package-surface",
  "Linux-authoritative release evidence",
  "gitar review",
  "Do not block merges, auto-approve",
  "Never force-push, push directly to `dev`, use `gitar unblock`",
].join("\n");

function validSources() {
  return {
    approvalExists: false,
    reviews: [
      { name: "00-governance-and-delivery.md", source: completeReviewSource },
      { name: "10-security-and-trust-boundaries.md", source: "security" },
      { name: "20-architecture-quality-and-evidence.md", source: "quality" },
    ],
    rules: [],
  };
}

describe("Gitar configuration gate", () => {
  it("accepts the checked-in Keiko Core configuration", () => {
    expect(validateGitarSources(loadGitarSources())).toEqual([]);
  });

  it("accepts the minimal valid Core contract fixture", () => {
    expect(validateGitarSources(validSources())).toEqual([]);
  });

  it("rejects Pro-only rules and Auto-Approve configuration", () => {
    const sources = validSources();
    sources.approvalExists = true;
    sources.rules.push({ name: "automation.md", source: "Pro automation" });

    expect(validateGitarSources(sources)).toEqual(
      expect.arrayContaining([
        "Gitar Core configuration must not include Pro Auto-Approve criteria",
        "Gitar Core configuration must not include Pro rule automation.md",
      ]),
    );
  });

  it("rejects unexpected review files and incomplete Core instructions", () => {
    const sources = validSources();
    sources.reviews[0].source = "no includes or invariants";
    sources.reviews.push({ name: "unbounded.md", source: "extra" });

    expect(validateGitarSources(sources)).toEqual(
      expect.arrayContaining([
        "Gitar review instructions has unexpected file unbounded.md",
        "Gitar review instructions must include @AGENTS.md",
        "Gitar Core review instructions must include: exact current head",
        "Gitar Core review instructions must include: Do not block merges, auto-approve",
      ]),
    );
  });
});
