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
import { fileURLToPath } from "node:url";

import { runUiCli, type CliIo } from "@oscharko-dev/keiko-cli";

import { resolveCodingIssueJourneyQualificationConfig } from "../support/coding-issue-journey-config.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const PORT = Number(process.env.KEIKO_E2E_UI_PORT ?? "4390");

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
  process.env.KEIKO_UI_STATIC_ROOT ??= resolve(REPO_ROOT, "dist", "ui", "static");

  const stateDir =
    process.env.KEIKO_E2E_STATE_DIR ?? resolve(REPO_ROOT, ".keiko-coding-issue-journey-e2e");

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
  return runUiCli(args, processIo(), process.env, {
    cwd: resolved.config.controlledRepositoryRoot,
  });
}

process.exitCode = await main();
