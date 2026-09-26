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
//   - `KEIKO_QUALIFICATION_SPEND_LEDGER_PATH`, an absolute durable SQLite target whose parent
//     already exists. Production reserves against this ledger before every provider attempt.
//
// Any missing input resolves to `qualification-input-unavailable` with the closed, named list of
// what is missing — never a silent fallback to scripted composition.

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { hasConfiguredEnvModelProvider } from "@oscharko-dev/keiko-model-gateway";

export interface CodingIssueJourneyQualificationConfig {
  readonly gatewayConfigPath: string | undefined;
  readonly controlledRepositoryRoot: string;
  readonly controlledRepositorySlug: string;
  readonly spendBudgetUsd: number;
  readonly spendLedgerPath: string;
}

export type CodingIssueJourneyQualificationResolution =
  | { readonly ok: true; readonly config: CodingIssueJourneyQualificationConfig }
  | {
      readonly ok: false;
      readonly reason: "qualification-input-unavailable";
      readonly missing: readonly string[];
    };

const GITHUB_REMOTE_PATTERN = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/u;

// Final-audit F13/F24: delegates to the SAME env-only provider-admission formula production's own
// `packages/keiko-server/src/deps.ts` composition uses (both `_API_KEY` and `_BASE_URL` must be
// present and non-empty), never a restated, weaker copy that accepts the API key alone -- an
// API-key-only environment used to report a qualifying profile here while production's own
// `hasEnvProvider` would refuse it, so the live #3390 lane could start a real server with no
// provider wired.
function hasEnvOnlyModelProfile(env: Readonly<Record<string, string | undefined>>): boolean {
  return hasConfiguredEnvModelProvider(env);
}

function resolveGatewayConfigPath(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const configPath = env.KEIKO_QUALIFICATION_GATEWAY_CONFIG_PATH;
  if (configPath !== undefined && configPath.length > 0) {
    try {
      const canonical = realpathSync(configPath);
      return statSync(canonical).isFile() ? canonical : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
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

function resolveSpendLedgerPath(
  env: Readonly<Record<string, string | undefined>>,
  missing: string[],
): string | undefined {
  const raw = env.KEIKO_QUALIFICATION_SPEND_LEDGER_PATH;
  let resolved: string | undefined;
  try {
    if (raw !== undefined && raw.length > 0 && isAbsolute(raw)) {
      const parent = realpathSync(dirname(raw));
      if (!existsSync(raw) || statSync(raw).isFile()) resolved = join(parent, basename(raw));
    }
  } catch {
    resolved = undefined;
  }
  if (resolved === undefined) {
    missing.push(
      "KEIKO_QUALIFICATION_SPEND_LEDGER_PATH (an absolute durable ledger path with an existing parent)",
    );
    return undefined;
  }
  return resolved;
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
  const requestedGatewayConfig = env.KEIKO_QUALIFICATION_GATEWAY_CONFIG_PATH;
  const hasRequestedGatewayConfig =
    requestedGatewayConfig !== undefined && requestedGatewayConfig.length > 0;
  const gatewayConfigPath = resolveGatewayConfigPath(env);
  if (
    gatewayConfigPath === undefined &&
    (hasRequestedGatewayConfig || !hasEnvOnlyModelProfile(env))
  ) {
    missing.push(
      "a real Model Gateway/LiteLLM profile (KEIKO_MODEL_<id>_API_KEY and _BASE_URL, or " +
        "KEIKO_QUALIFICATION_GATEWAY_CONFIG_PATH naming an existing gateway config file)",
    );
  }
  const repository = resolveControlledRepository(env, missing);
  const spendBudgetUsd = resolveSpendBudgetUsd(env, missing);
  const spendLedgerPath = resolveSpendLedgerPath(env, missing);

  if (
    missing.length > 0 ||
    repository === undefined ||
    spendBudgetUsd === undefined ||
    spendLedgerPath === undefined
  ) {
    return { ok: false, reason: "qualification-input-unavailable", missing };
  }
  return {
    ok: true,
    config: {
      gatewayConfigPath,
      controlledRepositoryRoot: repository.root,
      controlledRepositorySlug: repository.slug,
      spendBudgetUsd,
      spendLedgerPath,
    },
  };
}
