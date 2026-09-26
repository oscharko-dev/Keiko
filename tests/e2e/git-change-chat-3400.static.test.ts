import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const spec = readFileSync(join(ROOT, "tests/e2e/git-change-chat-3400.spec.ts"), "utf8");
const support = readFileSync(join(ROOT, "tests/e2e/support/git-change-chat-3400.ts"), "utf8");
const config = readFileSync(
  join(ROOT, "tests/e2e/config/playwright.git-change-chat-3400.config.ts"),
  "utf8",
);

describe("#3400 real Chat refinement journey source boundary", () => {
  it("does not intercept the PR connect or governed description lifecycle", () => {
    expect(spec).not.toContain("interceptGitChangePullRequestConnect");
    expect(spec).not.toContain("interceptPrDescriptionLifecycle");
    expect(spec).toContain("authorizeGitHubForFixture");
    expect(support).toContain("readGitChangeChatProviderState");
  });

  it("runs two connected turns against the bounded provider composition", () => {
    expect(spec.match(/await sendConnectedRefinement\(/gu)).toHaveLength(2);
    expect(config).toContain("model-mock-server.mjs");
    expect(config).toContain('"support", "git-change-chat-3400-gh.mjs"');
  });
});
