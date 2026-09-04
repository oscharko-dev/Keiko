#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { setTimeout as sleepFor } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { resolveHostExecutable } from "./lib/host-executable.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [15_000, 30_000];
const TRANSIENT_FAILURES = [
  /\b(?:429 Too Many Requests|500 Internal Server Error|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout)\b/iu,
  /audit endpoint returned an error/iu,
  /bad gateway/iu,
  /connection reset/iu,
  /eai_again/iu,
  /econnreset/iu,
  /enotfound/iu,
  /etimedout/iu,
  /gateway timeout/iu,
  /service unavailable/iu,
  /socket hang up/iu,
  /too many requests/iu,
];

export function isTransientAuditFailure(output) {
  return TRANSIENT_FAILURES.some((pattern) => pattern.test(output));
}

export function auditEnvironment(environment = process.env) {
  return {
    ...environment,
    npm_config_fetch_retries: "1",
    npm_config_fetch_retry_maxtimeout: "10000",
    npm_config_fetch_retry_mintimeout: "1000",
    npm_config_fetch_timeout: "60000",
  };
}

export function runNpmAudit(arguments_, dependencies = {}) {
  const spawn = dependencies.spawn ?? spawnSync;
  const executable = dependencies.resolveNpm?.() ?? resolveHostExecutable("npm");
  const result = spawn(executable, ["audit", ...arguments_], {
    cwd: dependencies.cwd ?? repoRoot,
    encoding: "utf8",
    env: auditEnvironment(dependencies.environment),
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const rawStderr = typeof result.stderr === "string" ? result.stderr : "";
  const error = result.error instanceof Error ? `${result.error.message}\n` : "";
  const stderr = `${rawStderr}${error}`;
  return {
    output: `${stdout}${stderr}`,
    status: typeof result.status === "number" ? result.status : 1,
    stderr,
    stdout,
  };
}

const defaultSleep = (delayMs) => sleepFor(delayMs);

function retryDependencies(dependencies) {
  return {
    runAudit: dependencies.runAudit ?? ((args) => runNpmAudit(args)),
    sleep: dependencies.sleep ?? defaultSleep,
    writeError: dependencies.writeError ?? ((value) => process.stderr.write(value)),
    writeOutput: dependencies.writeOutput ?? ((value) => process.stdout.write(value)),
  };
}

function emitAuditOutput(result, dependencies) {
  if (result.stdout.length > 0) dependencies.writeOutput(result.stdout);
  if (result.stderr.length > 0) dependencies.writeError(result.stderr);
}

export async function runAuditWithRetry(arguments_, dependencies = {}) {
  const retry = retryDependencies(dependencies);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = retry.runAudit(arguments_);
    emitAuditOutput(result, retry);
    if (result.status === 0) return 0;
    if (!isTransientAuditFailure(result.output) || attempt === MAX_ATTEMPTS) {
      return result.status;
    }

    const delayMs = RETRY_DELAYS_MS[attempt - 1];
    retry.writeError(
      `Transient npm audit service failure (attempt ${String(attempt)}/${String(MAX_ATTEMPTS)}); ` +
        `retrying in ${String(delayMs / 1000)} seconds.\n`,
    );
    await retry.sleep(delayMs);
  }

  return 1;
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runAuditWithRetry(process.argv.slice(2));
}
