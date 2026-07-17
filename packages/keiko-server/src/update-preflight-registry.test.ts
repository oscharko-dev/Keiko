import { describe, expect, it } from "vitest";
import { validateGitHubRelease } from "./update-preflight-registry.js";

const TARGET_VERSION = "1.2.3";

function releaseWithBody(body: string): unknown {
  return {
    tag_name: `v${TARGET_VERSION}`,
    name: "Release",
    body,
    html_url: "https://github.com/oscharko-dev/keiko/releases/tag/v1.2.3",
    published_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("validateGitHubRelease heading and bullet parsing", () => {
  it("extracts sections with normalized headings and deduplicated bullets", () => {
    const body = [
      "## Highlights ##",
      "- First bullet",
      "- Second bullet",
      "- second bullet",
      "###### Deep section",
      "* Third bullet",
    ].join("\n");

    const release = validateGitHubRelease(releaseWithBody(body), TARGET_VERSION);

    expect(release?.noteSections).toEqual([
      { title: "Highlights", bullets: ["First bullet", "Second bullet"] },
      { title: "Deep section", bullets: ["Third bullet"] },
    ]);
  });

  it("preserves the original lazy-capture's one-character quirk for an all-hash heading body", () => {
    // The pre-fix regex /^#{2,6}\s+(.+?)\s*#*$/u used a lazy `+` capture: when the entire
    // remainder after the marker is itself a valid trailing "\s*#*" run, the lazy quantifier
    // still has to consume at least one character, so it keeps the first character of that run
    // ("#") rather than stripping everything. The rewritten implementation must reproduce this
    // exact, if quirky, historical output.
    const body = ["###   ###", "- bullet under odd heading"].join("\n");

    const release = validateGitHubRelease(releaseWithBody(body), TARGET_VERSION);

    expect(release?.noteSections).toEqual([{ title: "#", bullets: ["bullet under odd heading"] }]);
  });

  it("ignores lines that are not headings or bullets", () => {
    const body = ["## Section", "plain paragraph text", "- a bullet", "#nohash-no-space"].join(
      "\n",
    );

    const release = validateGitHubRelease(releaseWithBody(body), TARGET_VERSION);

    expect(release?.noteSections).toEqual([{ title: "Section", bullets: ["a bullet"] }]);
  });
});

describe("validateGitHubRelease performance (SonarCloud S8786 regression)", () => {
  // Both normalizeHeading (/^#{2,6}\s+(.+?)\s*#*$/u) and the bullet matcher
  // (/^[*-]\s+(.+)$/u) used to chain quantifiers whose character classes overlap ("." matches
  // whitespace and "#"), the classic shape SonarCloud's S8786 flags for super-linear
  // backtracking. Large adversarial heading and bullet bodies — with no natural boundary for the
  // trailing run to latch onto — must resolve well within budget.
  it("stays fast validating a release with large adversarial heading and bullet lines", () => {
    const longHeadingBody = "a".repeat(15_000);
    const longBulletBody = "b".repeat(15_000);
    const body = [`## ${longHeadingBody}`, `- ${longBulletBody}`].join("\n");

    const start = Date.now();
    const release = validateGitHubRelease(releaseWithBody(body), TARGET_VERSION);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1500);
    expect(release?.noteSections).toEqual([{ title: longHeadingBody, bullets: [longBulletBody] }]);
  });

  it("stays fast on an adversarial heading with a long trailing whitespace/hash run", () => {
    const body = `## ${"a".repeat(10_000)} ${"#".repeat(10_000)}`;

    const start = Date.now();
    const release = validateGitHubRelease(releaseWithBody(body), TARGET_VERSION);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1500);
    expect(release?.noteSections).toEqual([]);
  });

  it("stays fast on an adversarial heading whose trailing hash run is followed by ordinary text", () => {
    // A trailing whitespace/hash run that reaches the true end of the string cleanly (as above)
    // is one of the O(n) cases for an unanchored \s*#*$ regex search. The true worst case is a
    // long hash run immediately followed by an ordinary, non-hash, non-whitespace character:
    // every starting position inside the hash run greedily consumes the rest of it and then has
    // to backtrack hash-by-hash trying to reach `$`, which never succeeds because of the
    // trailing character — O(n) starting positions x O(n) backtracking = O(n^2).
    const longHashRun = "#".repeat(50_000);
    const headingBody = `b${longHashRun}c`;
    const body = [`## ${headingBody}`, "- bullet under adversarial heading"].join("\n");

    const start = Date.now();
    const release = validateGitHubRelease(releaseWithBody(body), TARGET_VERSION);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1500);
    expect(release?.noteSections).toEqual([
      { title: headingBody, bullets: ["bullet under adversarial heading"] },
    ]);
  });
});
