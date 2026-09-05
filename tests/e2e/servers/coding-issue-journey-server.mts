// #3390: the real-model production-composition harness entry point. Unlike every other server in
// this directory, this file never imports `./coding-runtime-server-shared.mjs` and never
// constructs a scripted OpenCode/model resolver -- it launches the actual `keiko ui` production
// factory (`@oscharko-dev/keiko-cli`'s `runUiCli`, which internally composes the real
// `buildUiHandlerDeps` and `createUiServer` -- the exact same composition `npm run dev:start`
// uses) bound to whatever real Model Gateway/LiteLLM profile and controlled repository checkout
// the operator has configured through the existing configuration surface
// (`tests/e2e/support/coding-issue-journey-config.js`).
//
// When those qualification inputs are not configured, this process fails closed immediately: it
// prints the closed reason and every missing input, then exits 1. There is no fallback branch, so
// it is impossible for `npm run test:e2e:coding-issue-journey:live` to pass against a scripted or
// otherwise substituted runtime -- either this process launches the real product against a real
// model and a real repository, or the lane does not start at all.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runUiCli, type CliIo } from "@oscharko-dev/keiko-cli";

import { resolveCodingIssueJourneyQualificationConfig } from "../support/coding-issue-journey-config.js";

const PORT = Number(process.env.KEIKO_E2E_UI_PORT ?? "4390");

/**
 * Live-run bug (#3390 harness gap): the compiled entrypoint runs from
 * `tests/e2e/servers/dist/tests/e2e/servers/coding-issue-journey-server.mjs`, so resolving the
 * repository root from `import.meta.url` walked four segments up from THAT compiled path and
 * landed on `tests/e2e/servers/dist` -- `KEIKO_UI_STATIC_ROOT` then defaulted to
 * `.../dist/dist/ui/static` and `keiko ui` refused to start ("UI assets not found"). The sibling
 * harnesses (`coding-runtime-server-shared.mts`'s `runCodingRuntimeJourneyServer`) never derive
 * the repo root from the compiled file's own location at all -- they resolve `dist/ui/static`
 * from `process.cwd()`, because `playwright.coding-issue-*.config.ts`'s `webServer.cwd` is always
 * the repository root. This does the same: `repoRoot` is a parameter (not `process.cwd()`
 * resolved inline) so a unit test can prove the resolved path without depending on the actual
 * process cwd.
 */
export function defaultUiStaticRoot(repoRoot: string): string {
  return resolve(repoRoot, "dist", "ui", "static");
}

function defaultStateDir(repoRoot: string): string {
  return resolve(repoRoot, ".keiko-coding-issue-journey-e2e");
}

function processIo(): CliIo {
  return {
    out: (text: string): void => {
      process.stdout.write(text);
    },
    err: (text: string): void => {
      process.stderr.write(text);
    },
  };
}

/**
 * Threads the resolved, already-validated bounded evaluation budget into the launched process env
 * (#3390 audit F15) rather than relying on the raw, unvalidated `process.env` string this same
 * config surface read it from -- the launched process observes the exact positive number
 * `resolveCodingIssueJourneyQualificationConfig` accepted, never a re-parse of the original
 * string. Exported so a unit test can assert the env this process would launch with, without
 * spawning the real `keiko ui` composition.
 */
export function launchedEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
  spendBudgetUsd: number,
): Record<string, string | undefined> {
  return { ...baseEnv, KEIKO_QUALIFICATION_SPEND_BUDGET_USD: String(spendBudgetUsd) };
}

async function main(): Promise<number> {
  const resolved = resolveCodingIssueJourneyQualificationConfig(process.env);
  if (!resolved.ok) {
    process.stderr.write(
      `coding-issue-journey-server: ${resolved.reason} -- this lane never substitutes scripted ` +
        "composition, so it refuses to start:\n",
    );
    for (const missing of resolved.missing) {
      process.stderr.write(`  - ${missing}\n`);
    }
    return 1;
  }

  // Real UI assets: `keiko ui`'s static root defaults relative to the compiled CLI module, so a
  // harness invocation (never installed as a package) must point it at this checkout's own build.
  // `process.cwd()` is the repository root here (Playwright's `webServer.cwd`), never the
  // compiled file's own directory -- see `defaultUiStaticRoot` above.
  process.env.KEIKO_UI_STATIC_ROOT ??= defaultUiStaticRoot(process.cwd());

  const stateDir = process.env.KEIKO_E2E_STATE_DIR ?? defaultStateDir(process.cwd());

  const args = [
    "--port",
    String(PORT),
    "--host",
    "127.0.0.1",
    "--evidence-dir",
    resolve(stateDir, "evidence"),
    "--ui-db",
    resolve(stateDir, "ui-db", "keiko-ui.db"),
    ...(resolved.config.gatewayConfigPath === undefined
      ? []
      : ["--config", resolved.config.gatewayConfigPath]),
  ];

  // `cwd` is the real `keiko ui` launch directory: production resolves the connected project (and
  // therefore the per-checkout GitHub reader authorization the coding runtime reads issues and
  // opens PRs through) from it, exactly as when an operator runs `keiko ui` from inside their own
  // project. Pointing it at the controlled repository checkout is what makes this composition
  // real rather than a stand-in.
  return runUiCli(args, processIo(), launchedEnv(process.env, resolved.config.spendBudgetUsd), {
    cwd: resolved.config.controlledRepositoryRoot,
  });
}

// Guarded like the sibling `coding-issue-delivery-server.mts`: only run the real production
// composition when this file is the process entrypoint (Playwright's `webServer.command`), never
// as a side effect of another module importing it -- `launchedEnv` above is unit-tested this way
// (coding-issue-journey-server.test.ts) without launching the real server.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
