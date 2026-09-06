import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveCodingIssueJourneyQualificationConfig } from "./coding-issue-journey-config.js";

function githubCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-issue-journey-repo-"));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync(
    "git",
    ["remote", "add", "origin", "https://github.com/example-org/controlled-repo.git"],
    {
      cwd: root,
    },
  );
  return root;
}

function nonGitCheckout(): string {
  return mkdtempSync(join(tmpdir(), "coding-issue-journey-nongit-"));
}

const dirsToClean: string[] = [];

afterEach((): void => {
  while (dirsToClean.length > 0) {
    const dir = dirsToClean.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function trackedGithubCheckout(): string {
  const root = githubCheckout();
  dirsToClean.push(root);
  return root;
}

function trackedNonGitCheckout(): string {
  const root = nonGitCheckout();
  dirsToClean.push(root);
  return root;
}

function fullyConfiguredEnv(repositoryRoot: string): Record<string, string | undefined> {
  return {
    KEIKO_MODEL_CODING_ISSUE_JOURNEY_API_KEY: "sk-fixture-not-a-real-secret",
    KEIKO_MODEL_CODING_ISSUE_JOURNEY_BASE_URL: "https://gateway.internal.example/v1",
    KEIKO_QUALIFICATION_CONTROLLED_REPOSITORY_ROOT: repositoryRoot,
    KEIKO_QUALIFICATION_SPEND_BUDGET_USD: "5",
    KEIKO_QUALIFICATION_SPEND_LEDGER_PATH: join(repositoryRoot, "spend.db"),
  };
}

describe("resolveCodingIssueJourneyQualificationConfig", () => {
  it("fails closed on a completely empty environment, naming every missing input", () => {
    const result = resolveCodingIssueJourneyQualificationConfig({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("qualification-input-unavailable");
    expect(result.missing).toHaveLength(4);
    expect(result.missing.some((entry) => entry.includes("Model Gateway"))).toBe(true);
    expect(result.missing.some((entry) => entry.includes("CONTROLLED_REPOSITORY_ROOT"))).toBe(true);
    expect(result.missing.some((entry) => entry.includes("SPEND_BUDGET_USD"))).toBe(true);
    expect(result.missing.some((entry) => entry.includes("SPEND_LEDGER_PATH"))).toBe(true);
  });

  it("resolves ok when a real env-only model profile, a real controlled checkout, and a budget are all present", () => {
    const root = trackedGithubCheckout();
    const result = resolveCodingIssueJourneyQualificationConfig(fullyConfiguredEnv(root));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Canonicalized (realpath'd), matching githubIssueReaderRepositoryId's own resolution --
    // macOS resolves the system tmp dir through a /private symlink, so a raw string comparison
    // against `root` is not portable.
    expect(result.config.controlledRepositoryRoot).toBe(realpathSync(root));
    expect(result.config.controlledRepositorySlug).toBe("example-org/controlled-repo");
    expect(result.config.spendBudgetUsd).toBe(5);
    expect(result.config.spendLedgerPath).toBe(join(realpathSync(root), "spend.db"));
    expect(result.config.gatewayConfigPath).toBeUndefined();
  });

  // Final-audit F13/F24 regression: production's own `hasEnvProvider` (packages/keiko-server/src/
  // deps.ts) requires BOTH `_API_KEY` and `_BASE_URL` non-empty before treating an env-only
  // profile as configured. Before this fix, this harness's `hasEnvOnlyModelProfile` accepted the
  // API key alone, so a live #3390 lane could start a real server with no provider wired at all.
  it("fails closed on an env-only profile missing its base URL (API key alone does not qualify)", () => {
    const root = trackedGithubCheckout();
    const env = { ...fullyConfiguredEnv(root) };
    delete env.KEIKO_MODEL_CODING_ISSUE_JOURNEY_BASE_URL;
    const result = resolveCodingIssueJourneyQualificationConfig(env);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing.some((entry) => entry.includes("Model Gateway"))).toBe(true);
  });

  it("fails closed on an env-only profile missing its API key (base URL alone does not qualify)", () => {
    const root = trackedGithubCheckout();
    const env = { ...fullyConfiguredEnv(root) };
    delete env.KEIKO_MODEL_CODING_ISSUE_JOURNEY_API_KEY;
    const result = resolveCodingIssueJourneyQualificationConfig(env);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing.some((entry) => entry.includes("Model Gateway"))).toBe(true);
  });

  it("accepts a gateway config file path in place of the env-only profile", () => {
    const root = trackedGithubCheckout();
    const configDir = mkdtempSync(join(tmpdir(), "coding-issue-journey-gateway-config-"));
    dirsToClean.push(configDir);
    const configPath = join(configDir, "keiko.config.json");
    writeFileSync(configPath, JSON.stringify({ providers: [] }));
    const env = {
      KEIKO_QUALIFICATION_GATEWAY_CONFIG_PATH: configPath,
      KEIKO_QUALIFICATION_CONTROLLED_REPOSITORY_ROOT: root,
      KEIKO_QUALIFICATION_SPEND_BUDGET_USD: "1.5",
      KEIKO_QUALIFICATION_SPEND_LEDGER_PATH: join(root, "spend.db"),
    };
    const result = resolveCodingIssueJourneyQualificationConfig(env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.gatewayConfigPath).toBe(configPath);
  });

  it("rejects a gateway config path that does not exist on disk", () => {
    const root = trackedGithubCheckout();
    const env = {
      KEIKO_QUALIFICATION_GATEWAY_CONFIG_PATH: join(root, "does-not-exist.json"),
      KEIKO_QUALIFICATION_CONTROLLED_REPOSITORY_ROOT: root,
      KEIKO_QUALIFICATION_SPEND_BUDGET_USD: "1",
      KEIKO_QUALIFICATION_SPEND_LEDGER_PATH: join(root, "spend.db"),
    };
    const result = resolveCodingIssueJourneyQualificationConfig(env);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing.some((entry) => entry.includes("Model Gateway"))).toBe(true);
  });

  it("rejects a controlled-repository root that is not a git checkout at all", () => {
    const root = trackedNonGitCheckout();
    const result = resolveCodingIssueJourneyQualificationConfig(fullyConfiguredEnv(root));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.missing.some((entry) => entry.includes("must resolve a GitHub origin remote")),
    ).toBe(true);
  });

  it("rejects a controlled-repository root that does not exist on disk", () => {
    const missingRoot = join(tmpdir(), "coding-issue-journey-does-not-exist-anywhere");
    const result = resolveCodingIssueJourneyQualificationConfig(fullyConfiguredEnv(missingRoot));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing.some((entry) => entry.includes("CONTROLLED_REPOSITORY_ROOT"))).toBe(true);
  });

  it("rejects a zero, negative, or non-numeric spend budget", () => {
    const root = trackedGithubCheckout();
    for (const budget of ["0", "-1", "not-a-number", ""]) {
      const env = { ...fullyConfiguredEnv(root), KEIKO_QUALIFICATION_SPEND_BUDGET_USD: budget };
      const result = resolveCodingIssueJourneyQualificationConfig(env);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.missing.some((entry) => entry.includes("SPEND_BUDGET_USD"))).toBe(true);
    }
  });

  it("rejects a missing, relative, or parentless durable spend ledger path", () => {
    const root = trackedGithubCheckout();
    const invalidPaths = [undefined, "relative/spend.db", join(root, "missing-parent", "spend.db")];
    for (const ledgerPath of invalidPaths) {
      const env = {
        ...fullyConfiguredEnv(root),
        KEIKO_QUALIFICATION_SPEND_LEDGER_PATH: ledgerPath,
      };
      const result = resolveCodingIssueJourneyQualificationConfig(env);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.missing.some((entry) => entry.includes("SPEND_LEDGER_PATH"))).toBe(true);
    }
  });
});

describe("controlled-repository slug extraction (defense against a real fixture regression)", () => {
  it("extracts owner/repo from both the https and ssh GitHub remote forms", () => {
    const httpsRoot = trackedGithubCheckout();
    const sshRoot = trackedNonGitCheckout();
    execFileSync("git", ["init", "--quiet"], { cwd: sshRoot });
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:example-org/controlled-repo.git"],
      { cwd: sshRoot },
    );
    const httpsResult = resolveCodingIssueJourneyQualificationConfig(fullyConfiguredEnv(httpsRoot));
    const sshResult = resolveCodingIssueJourneyQualificationConfig(fullyConfiguredEnv(sshRoot));
    expect(httpsResult.ok && httpsResult.config.controlledRepositorySlug).toBe(
      "example-org/controlled-repo",
    );
    expect(sshResult.ok && sshResult.config.controlledRepositorySlug).toBe(
      "example-org/controlled-repo",
    );
  });
});
