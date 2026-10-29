import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { sign } from "sigstore";

// sigstore's defaults allow 5 s per request. A Rekor entry that commits after the client already
// timed out turns the library's own retry into a 409 conflict, which `sign` never resolves
// (#4122). Each request therefore gets a generous timeout, and a transient failure starts a fresh
// signing attempt with a new ephemeral key instead of replaying the same entry.
export const SIGNING_OPTIONS = Object.freeze({ tlogUpload: true, timeout: 30_000 });
export const SIGNING_ATTEMPTS = 3;
export const SIGNING_BACKOFF_MS = Object.freeze([10_000, 30_000]);

const TRANSIENT_STATUSES = new Set([408, 409, 429]);
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const SIGSTORE_CODE = /^[A-Z][A-Z_]{0,63}$/u;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,47}$/u;

const DEFAULT_SIGNING_DEPENDENCIES = Object.freeze({
  readFile: readFileSync,
  signReceipt: sign,
  writeFile: writeFileSync,
  sleep: delay,
});

function outputPath(argv) {
  const [receipt, bundle] = argv.slice(2);
  if (argv.length !== 4 || !isAbsolute(receipt ?? "") || !isAbsolute(bundle ?? ""))
    return undefined;
  return { receipt: resolve(receipt), bundle: resolve(bundle) };
}

function httpStatus(error) {
  const status = error?.cause?.statusCode ?? error?.statusCode;
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

function hasNetworkCode(error) {
  return [error?.code, error?.cause?.code, error?.cause?.cause?.code].some(
    (candidate) => typeof candidate === "string" && TRANSIENT_NETWORK_CODES.has(candidate),
  );
}

function isTimeout(error) {
  return [error, error?.cause].some(
    (value) => value?.name === "AbortError" || value?.name === "TimeoutError",
  );
}

function failureClassOf(error, status) {
  if (status !== undefined && (status >= 500 || TRANSIENT_STATUSES.has(status)))
    return `http-${String(status)}`;
  if (hasNetworkCode(error)) return "network";
  if (isTimeout(error)) return "timeout";
  return "deterministic";
}

/**
 * The closed, body-free shape of a signing failure: never the message, a URL, a token, a
 * certificate or a path. `code` is sigstore's own error code, `status` the HTTP status it saw.
 */
export function classifySigningFailure(error) {
  const status = httpStatus(error);
  const failureClass = failureClassOf(error, status);
  return {
    failureClass,
    transient: failureClass !== "deterministic",
    code: typeof error?.code === "string" && SIGSTORE_CODE.test(error.code) ? error.code : "",
    name: typeof error?.name === "string" && ERROR_NAME.test(error.name) ? error.name : "Error",
    status,
  };
}

function describeFailure(failure, attempt) {
  const parts = [
    `attempt=${String(attempt)}/${String(SIGNING_ATTEMPTS)}`,
    `class=${failure.failureClass}`,
    `name=${failure.name}`,
  ];
  if (failure.code !== "") parts.push(`code=${failure.code}`);
  if (failure.status !== undefined) parts.push(`status=${String(failure.status)}`);
  return `linux-runtime-qualification-signing: ${parts.join(" ")}\n`;
}

async function signWithRetry(receipt, dependencies, stderr) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await dependencies.signReceipt(receipt, SIGNING_OPTIONS);
    } catch (error) {
      const failure = classifySigningFailure(error);
      stderr.write(describeFailure(failure, attempt));
      if (!failure.transient || attempt >= SIGNING_ATTEMPTS) throw error;
      await dependencies.sleep(SIGNING_BACKOFF_MS[attempt - 1] ?? SIGNING_BACKOFF_MS.at(-1));
    }
  }
}

export async function signLinuxRuntimeQualification(
  argv = process.argv,
  dependencies = DEFAULT_SIGNING_DEPENDENCIES,
  stderr = process.stderr,
) {
  const paths = outputPath(argv);
  if (paths === undefined) return 2;
  const receipt = dependencies.readFile(paths.receipt);
  const bundle = await signWithRetry(receipt, dependencies, stderr);
  dependencies.writeFile(paths.bundle, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
  return 0;
}

export async function runSignLinuxRuntimeQualificationCli(
  argv = process.argv,
  dependencies = DEFAULT_SIGNING_DEPENDENCIES,
  stderr = process.stderr,
) {
  try {
    return await signLinuxRuntimeQualification(argv, dependencies, stderr);
  } catch {
    stderr.write("linux-runtime-qualification-signing: redacted failure\n");
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runSignLinuxRuntimeQualificationCli();
}
