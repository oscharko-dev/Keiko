// #3390: resolves the qualification inputs the real-model production-composition harness needs
// before it may start — a real Model Gateway/LiteLLM profile and an operator-provided controlled
// repository checkout — through the SAME configuration surface production already reads (never a
// harness-only shortcut, never a secret read from the repository itself):
//   - `KEIKO_MODEL_<TOKEN>_API_KEY` / `KEIKO_MODEL_<TOKEN>_BASE_URL`, the env-only gateway wiring
//     `packages/keiko-server/src/deps.ts`'s `resolveEnvOnlyConfig` already reads, OR
//     `KEIKO_QUALIFICATION_GATEWAY_CONFIG_PATH` naming a `keiko.config.json`-shaped file consumed
//     through the real `keiko ui --config` flag (`@oscharko-dev/keiko-model-gateway`'s
//     `loadConfigFromFile`).
//   - `KEIKO_QUALIFICATION_CONTROLLED_REPOSITORY_ROOT`, an existing local checkout whose `origin`
//     remote resolves to a GitHub repository — the same per-checkout binding
//     `packages/keiko-server/src/coding-context/githubIssueReaderAuthorization.ts` uses.
//   - `KEIKO_QUALIFICATION_SPEND_BUDGET_USD`, a positive bounded evaluation budget (issue #3390:
//     "Do not provision paid resources ... spend beyond operator-approved evaluation budgets").
//
// Any missing input resolves to `qualification-input-unavailable` with the closed, named list of
// what is missing — never a silent fallback to scripted composition.

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";

export interface CodingIssueJourneyQualificationConfig {
  readonly gatewayConfigPath: string | undefined;
  readonly controlledRepositoryRoot: string;
  readonly controlledRepositorySlug: string;
  readonly spendBudgetUsd: number;
}

export type CodingIssueJourneyQualificationResolution =
  | { readonly ok: true; readonly config: CodingIssueJourneyQualificationConfig }
  | {
      readonly ok: false;
      readonly reason: "qualification-input-unavailable";
      readonly missing: readonly string[];
    };

const MODEL_API_KEY_PATTERN = /^KEIKO_MODEL_[A-Z0-9_]+_API_KEY$/u;
const GITHUB_REMOTE_PATTERN = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/u;

function hasEnvOnlyModelProfile(env: Readonly<Record<string, string | undefined>>): boolean {
  return Object.keys(env).some(
    (key) => MODEL_API_KEY_PATTERN.test(key) && (env[key]?.length ?? 0) > 0,
  );
}

function hasRealModelGatewayProfile(env: Readonly<Record<string, string | undefined>>): boolean {
  const configPath = env.KEIKO_QUALIFICATION_GATEWAY_CONFIG_PATH;
  if (configPath !== undefined && configPath.length > 0) {
    return existsSync(configPath);
  }
  return hasEnvOnlyModelProfile(env);
}

/** Resolves `root` to a canonical absolute path, or `undefined` when it does not exist. Mirrors
 * `githubIssueReaderRepositoryId`'s own canonicalisation so a symlinked checkout (every path
 * under macOS `/tmp` is one) resolves the same way the production reader resolves it. */
function canonicalRoot(root: string): string | undefined {
  try {
    return realpathSync(root);
  } catch {
    return undefined;
  }
}

/** The controlled repository's GitHub `owner/repo` slug, or `undefined` when `root` is not a git
 * checkout with a GitHub `origin` remote. */
function controlledRepositorySlug(root: string): string | undefined {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return GITHUB_REMOTE_PATTERN.exec(remote)?.[1];
  } catch {
    return undefined;
  }
}

function resolveControlledRepository(
  env: Readonly<Record<string, string | undefined>>,
  missing: string[],
): { readonly root: string; readonly slug: string } | undefined {
  const rawRoot = env.KEIKO_QUALIFICATION_CONTROLLED_REPOSITORY_ROOT;
  const root = rawRoot === undefined || rawRoot.length === 0 ? undefined : canonicalRoot(rawRoot);
  if (root === undefined) {
    missing.push(
      "KEIKO_QUALIFICATION_CONTROLLED_REPOSITORY_ROOT (an existing local checkout of the " +
        "operator-authorized controlled repository)",
    );
    return undefined;
  }
  const slug = controlledRepositorySlug(root);
  if (slug === undefined) {
    missing.push(
      "KEIKO_QUALIFICATION_CONTROLLED_REPOSITORY_ROOT must resolve a GitHub origin remote",
    );
    return undefined;
  }
  return { root, slug };
}

function resolveSpendBudgetUsd(
  env: Readonly<Record<string, string | undefined>>,
  missing: string[],
): number | undefined {
  const raw = env.KEIKO_QUALIFICATION_SPEND_BUDGET_USD;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    missing.push(
      "KEIKO_QUALIFICATION_SPEND_BUDGET_USD (a positive, bounded operator-approved evaluation budget)",
    );
    return undefined;
  }
  return parsed;
}

/**
 * Resolves the qualification inputs, or reports the closed `qualification-input-unavailable`
 * reason with every missing input named. Never throws and never reads a secret value — only
 * whether an env-named indirection or an on-disk path exists.
 */
export function resolveCodingIssueJourneyQualificationConfig(
  env: Readonly<Record<string, string | undefined>>,
): CodingIssueJourneyQualificationResolution {
  const missing: string[] = [];
  if (!hasRealModelGatewayProfile(env)) {
    missing.push(
      "a real Model Gateway/LiteLLM profile (KEIKO_MODEL_<id>_API_KEY and _BASE_URL, or " +
        "KEIKO_QUALIFICATION_GATEWAY_CONFIG_PATH naming an existing gateway config file)",
    );
  }
  const repository = resolveControlledRepository(env, missing);
  const spendBudgetUsd = resolveSpendBudgetUsd(env, missing);

  if (missing.length > 0 || repository === undefined || spendBudgetUsd === undefined) {
    return { ok: false, reason: "qualification-input-unavailable", missing };
  }
  return {
    ok: true,
    config: {
      gatewayConfigPath: env.KEIKO_QUALIFICATION_GATEWAY_CONFIG_PATH,
      controlledRepositoryRoot: repository.root,
      controlledRepositorySlug: repository.slug,
      spendBudgetUsd,
    },
  };
}
