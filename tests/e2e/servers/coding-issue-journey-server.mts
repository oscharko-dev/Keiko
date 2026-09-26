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

import { randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runUiCli, type CliIo } from "@oscharko-dev/keiko-cli";
import { SESSION_PAIRING_LAUNCHER_SECRET_ENV } from "@oscharko-dev/keiko-server";

import { resolveCodingIssueJourneyQualificationConfig } from "../support/coding-issue-journey-config.js";

const PORT = Number(process.env.KEIKO_E2E_UI_PORT ?? "4390");
const GENERATED_LAUNCHER_SECRET_BYTES = 32;

/**
 * Live-run bug (#3390 harness gap): the real Coding Workbench refused to start ("Workbench is not
 * paired. Open Keiko from the launcher.") because this harness never pairs the browser at all --
 * unlike `coding-issue-intake.spec.ts` (#3385), which mints a launcher pairing attestation
 * (`mintLauncherPairingAttestation`) against a secret the launched server also holds. This resolves
 * that SAME secret: the operator-provided `KEIKO_QUALIFICATION_LAUNCHER_SECRET` (threaded in by
 * `playwright.coding-issue-journey.config.ts`, which is the only place that also hands the value to
 * the spec process) when present, or a freshly generated one otherwise so a standalone invocation
 * of this server never runs unpaired-only. Never logged -- `processIo` above is the only sanctioned
 * stdout/stderr writer in this file and never receives this value.
 */
export function resolveLauncherSecret(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env.KEIKO_QUALIFICATION_LAUNCHER_SECRET;
  return configured !== undefined && configured.length > 0
    ? configured
    : randomBytes(GENERATED_LAUNCHER_SECRET_BYTES).toString("hex");
}

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

// Live-run bug: `keiko ui`'s own `--ui-db` CLI validation
// (`packages/keiko-server/src/store/paths.ts`'s `resolveUiDbPath`) rejects a path "inside the
// current workspace" unless it sits under the literal `<process.cwd()>/.keiko` exemption --
// `playwright.coding-issue-journey.config.ts`'s `KEIKO_E2E_STATE_DIR` nests under `.keiko` for
// exactly this reason, so this fallback (only reached when this server is launched WITHOUT that
// config, e.g. directly) matches it rather than reintroducing the same failure standalone.
export function defaultStateDir(repoRoot: string): string {
  return resolve(repoRoot, ".keiko", "coding-issue-journey-e2e");
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

export function evaluationLocalGitMutationEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
  identityHome: string | undefined,
): Record<string, string | undefined> | undefined {
  if (identityHome === undefined) return undefined;
  if (!isAbsolute(identityHome) || identityHome.length > 4_096 || /[\r\n\0]/u.test(identityHome))
    throw new TypeError("qualification-git-identity-home-invalid");
  return { ...baseEnv, HOME: identityHome };
}

/**
 * Lane-only variables (the `KEIKO_QUALIFICATION_*` namespace) never reach the product: the launched
 * server's environment must equal a real operator's plus the documented operator settings the lane
 * threads in explicitly below. The spawn boundary's fail-closed output scrub treats every
 * non-allowlisted parent env value as a secret, so a lane value that legitimately overlaps provider
 * data -- rehearsal run-19's fixture repository slug inside a pull-request response, a CI log or a
 * pull-request body -- would otherwise be written out of that data as a redaction marker (#3390).
 */
const LANE_ONLY_ENV_PREFIX = "KEIKO_QUALIFICATION_";
// The two documented operator settings the product itself reads under this prefix
// (`gateway-spend-budget.ts`); `launchedEnv` threads their validated values in explicitly.
const PRODUCT_LANE_SETTINGS: ReadonlySet<string> = new Set([
  "KEIKO_QUALIFICATION_SPEND_BUDGET_USD",
  "KEIKO_QUALIFICATION_SPEND_LEDGER_PATH",
]);

function isLaneOnlyVariable(name: string): boolean {
  return name.startsWith(LANE_ONLY_ENV_PREFIX) && !PRODUCT_LANE_SETTINGS.has(name);
}

function withoutLaneOnlyVariables(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !isLaneOnlyVariable(name)));
}

/** The product runs inside THIS process (`runUiCli` composes it in-process) and its adapters read
 * `process.env` directly, so the launched env alone cannot keep lane-only variables away from the
 * spawn boundary's output scrub: they are removed from the process env itself once this entry has
 * consumed them. Exported for the unit test. */
export function pruneLaneOnlyVariables(env: Record<string, string | undefined>): void {
  for (const name of Object.keys(env)) {
    if (isLaneOnlyVariable(name)) Reflect.deleteProperty(env, name);
  }
}

/**
 * Threads the resolved, already-validated bounded evaluation budget, and the resolved launcher
 * pairing secret, into the launched process env (#3390 audit F15; live-run pairing fix) rather
 * than relying on the raw, unvalidated `process.env` string this same config surface read it
 * from -- the launched process observes the exact positive number
 * `resolveCodingIssueJourneyQualificationConfig` accepted, never a re-parse of the original
 * string, and the exact launcher secret `resolveLauncherSecret` resolved, under the SAME env key
 * (`SESSION_PAIRING_LAUNCHER_SECRET_ENV`) the real `keiko-server` pairing port reads
 * (`launcherSessionPairingPort.ts`'s `resolveLauncherSecret`) -- never a differently-named,
 * harness-only variable. Exported so a unit test can assert the env this process would launch
 * with, without spawning the real `keiko ui` composition.
 */
export function launchedEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
  spendBudgetUsd: number,
  spendLedgerPath: string,
  launcherSecret: string,
): Record<string, string | undefined> {
  return {
    ...withoutLaneOnlyVariables(baseEnv),
    // This entry point is the trusted launcher for the live qualification lane. It invokes
    // `runUiCli` directly rather than `npm run dev:start`, so it must opt into the same supported,
    // byte-verified dev runtime that the normal development launcher enables. Discovery still
    // re-verifies the staged pinned OpenCode payload and reports the honest
    // `functional-not-platform-qualified` evidence class; this flag cannot bypass a missing,
    // stale, unapproved or tampered payload.
    KEIKO_CODING_RUNTIME_DEV_LANE: "1",
    KEIKO_QUALIFICATION_SPEND_BUDGET_USD: String(spendBudgetUsd),
    KEIKO_QUALIFICATION_SPEND_LEDGER_PATH: spendLedgerPath,
    [SESSION_PAIRING_LAUNCHER_SECRET_ENV]: launcherSecret,
  };
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
  const launcherSecret = resolveLauncherSecret(process.env);
  const identityHome = process.env.KEIKO_QUALIFICATION_GIT_IDENTITY_HOME;
  pruneLaneOnlyVariables(process.env);
  const serverEnv = launchedEnv(
    process.env,
    resolved.config.spendBudgetUsd,
    resolved.config.spendLedgerPath,
    launcherSecret,
  );
  const localGitMutationEnv = evaluationLocalGitMutationEnv(serverEnv, identityHome);
  return runUiCli(args, processIo(), serverEnv, {
    cwd: resolved.config.controlledRepositoryRoot,
    ...(localGitMutationEnv === undefined ? {} : { localGitMutationEnv }),
  });
}

// Guarded like the sibling `coding-issue-delivery-server.mts`: only run the real production
// composition when this file is the process entrypoint (Playwright's `webServer.command`), never
// as a side effect of another module importing it -- `launchedEnv` above is unit-tested this way
// (coding-issue-journey-server.test.ts) without launching the real server.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
