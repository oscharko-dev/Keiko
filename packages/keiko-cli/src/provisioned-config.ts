// Adoption of an administrator-provisioned gateway configuration at `keiko start` (ADR-0121 D9).
//
// An administrator prepares one `keiko.config.json` for a group of people and ships it next to the
// start files of a standalone folder package. `keiko start --provisioned-config PATH` adopts that
// file as this installation's gateway configuration whenever its bytes differ from the last file
// adopted here, so a rotated key or a changed gateway arrives with the next package and needs no
// action from the person. The file is authoritative: it replaces the configuration as a whole.
//
// The provisioned file may carry a plaintext `apiKey`. It is an administrator-owned input outside
// Keiko's custody (ADR-0046 D5); the startup migration of the UI process seals the adopted copy
// (ADR-0046 D4). Before a file replaces the configuration it must load through the gateway's own
// config loader, the one the UI process uses: a file that only looks like a configuration would
// otherwise replace a working one and leave no way back. Nothing here logs or reports the content:
// the activity line carries the closed outcome and an error class only.

import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import {
  emitSecurityLogEvent,
  securityErrorKind,
  type SecurityLogSink,
} from "@oscharko-dev/keiko-security";
import { atomicPublishRename } from "@oscharko-dev/keiko-security/fs-atomic-rename";
import { loadModelGateway } from "./lazy-modules.js";
import {
  GATEWAY_CONFIG_FILENAME,
  PROVISIONED_CONFIG_MARKER_FILENAME,
  RUNTIME_STATE_DIR_MODE,
  RUNTIME_STATE_FILE_MODE,
  defaultUiDataDir,
} from "./state-paths.js";

/** A gateway configuration is a few kilobytes; a megabyte is a file that is something else. */
export const PROVISIONED_CONFIG_MAX_BYTES = 1024 * 1024;
const MARKER_MAX_BYTES = 4096;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const FAILURE_OUTCOMES = [
  "invalid",
  "too-large",
  "refused-link",
  "read-failed",
  "write-failed",
  "marker-failed",
] as const;

export type ProvisionedConfigOutcome =
  | "adopted"
  | "unchanged"
  | "deferred-running"
  | "overridden"
  | "absent"
  | (typeof FAILURE_OUTCOMES)[number];

export interface ProvisionedConfigResult {
  readonly outcome: ProvisionedConfigOutcome;
  readonly error?: unknown;
}

const PROVISIONED_CONFIG_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "cli.lifecycle.provisioned-config",
  category: "diagnostic",
  owner: "keiko-cli",
  emitter: "provisioned-config.emitProvisionedConfig",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "adopted",
        "unchanged",
        "deferred-running",
        "overridden",
        "absent",
        "invalid",
        "too-large",
        "refused-link",
        "read-failed",
        "write-failed",
        "marker-failed",
      ],
    },
    failureKind: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "process-lifecycle",
  diagnosticWhen: [{ field: "outcome", values: [...FAILURE_OUTCOMES] }],
  failureClasses: ["provisioned-config-adoption"],
  proofIds: ["cli.lifecycle.provisioned-config.outcome"],
  releaseImpact: "minor",
});

function isFailureOutcome(outcome: ProvisionedConfigOutcome): boolean {
  return (FAILURE_OUTCOMES as readonly string[]).includes(outcome);
}

/** Record the adoption decision: the closed outcome and an error class, never path or content. */
export function emitProvisionedConfig(
  sink: SecurityLogSink | undefined,
  result: ProvisionedConfigResult,
): void {
  const failureKind = result.error === undefined ? undefined : securityErrorKind(result.error);
  emitSecurityLogEvent(
    sink,
    activityLogEvent(
      PROVISIONED_CONFIG_OPERATION,
      isFailureOutcome(result.outcome)
        ? { level: "warn", errorKind: "unavailable" }
        : { level: "info" },
      { outcome: result.outcome, ...(failureKind === undefined ? {} : { failureKind }) },
    ),
  );
}

function recordOutcome(
  sink: SecurityLogSink | undefined,
  outcome: ProvisionedConfigOutcome,
  error?: unknown,
): ProvisionedConfigResult {
  const result: ProvisionedConfigResult = error === undefined ? { outcome } : { outcome, error };
  emitProvisionedConfig(sink, result);
  return result;
}

// An adoption that ends anywhere but in a decision ends here: the step that saw the fault names
// the closed outcome and keeps the cause, and the one place that records writes the line. Thrown
// rather than returned, so that no step can record a line of its own and a cleanup that fails
// after a fault cannot add a second one.
class AdoptionEnded extends Error {
  readonly outcome: ProvisionedConfigOutcome;
  readonly fault: unknown;

  constructor(outcome: ProvisionedConfigOutcome, fault?: unknown) {
    super(outcome);
    this.name = "AdoptionEnded";
    this.outcome = outcome;
    this.fault = fault;
  }
}

function recordEnded(sink: SecurityLogSink | undefined, error: unknown): ProvisionedConfigResult {
  return error instanceof AdoptionEnded
    ? recordOutcome(sink, error.outcome, error.fault)
    : // A fault of the state directory that no step foresaw: nothing was adopted.
      recordOutcome(sink, "write-failed", error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function openEnded(error: unknown): AdoptionEnded {
  const code = errorCode(error);
  // An absent file is the ordinary case of a package without a configuration, not a fault.
  if (code === "ENOENT") return new AdoptionEnded("absent");
  // ELOOP is what O_NOFOLLOW answers for a link; a link names bytes outside the package folder.
  return new AdoptionEnded(code === "ELOOP" ? "refused-link" : "read-failed", error);
}

// O_NOFOLLOW and O_NONBLOCK do not exist on Windows, where the constant is undefined.
function openFlag(flag: number | undefined): number {
  return flag ?? 0;
}

function openProvisionedFile(path: string): number {
  try {
    // lstat first: a link must be refused on every platform, and anything that is not a regular
    // file must be refused before it is opened (opening a FIFO would block the start for good).
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) throw new AdoptionEnded("refused-link");
    if (!entry.isFile()) throw new AdoptionEnded("invalid");
    const flags =
      fsConstants.O_RDONLY | openFlag(fsConstants.O_NOFOLLOW) | openFlag(fsConstants.O_NONBLOCK);
    return openSync(path, flags);
  } catch (error) {
    throw error instanceof AdoptionEnded ? error : openEnded(error);
  }
}

function readDescriptor(fd: number): Buffer {
  const stat = fstatSync(fd);
  if (!stat.isFile()) throw new AdoptionEnded("invalid");
  if (stat.size > PROVISIONED_CONFIG_MAX_BYTES) throw new AdoptionEnded("too-large");
  const bytes = Buffer.alloc(stat.size);
  let filled = 0;
  while (filled < bytes.byteLength) {
    const read = readSync(fd, bytes, filled, bytes.byteLength - filled, filled);
    if (read === 0) break;
    filled += read;
  }
  // A file that changed size while it was read is not the file that was measured.
  if (filled !== bytes.byteLength) throw new AdoptionEnded("read-failed");
  return bytes;
}

function readProvisionedFile(path: string): Buffer {
  const fd = openProvisionedFile(path);
  try {
    try {
      return readDescriptor(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    throw error instanceof AdoptionEnded ? error : new AdoptionEnded("read-failed", error);
  }
}

// An editor may save UTF-8 with a byte order mark; the configuration is the text after it.
function withoutByteOrderMark(bytes: Buffer): Buffer {
  return bytes.subarray(0, UTF8_BOM.byteLength).equals(UTF8_BOM)
    ? bytes.subarray(UTF8_BOM.byteLength)
    : bytes;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// The marker is one line: the digest of the file adopted last. Anything else in its place (no
// file, a directory, other text) means "nothing adopted yet", and the file is adopted again,
// which is idempotent. A marker that exists but cannot be read is a state-directory fault and
// surfaces as one.
function adoptedSha256(markerPath: string): string | undefined {
  const entry = lstatSync(markerPath, { throwIfNoEntry: false });
  if (entry === undefined || !entry.isFile() || entry.size > MARKER_MAX_BYTES) return undefined;
  const text = readFileSync(markerPath, "utf8").trim();
  return SHA256_PATTERN.test(text) ? text : undefined;
}

// The UI data directory is created private; one that already exists must be a real directory. A
// link in its place would send the configuration and its key wherever the link points.
function ensureUiDataDir(uiDataDir: string): void {
  mkdirSync(uiDataDir, { recursive: true, mode: RUNTIME_STATE_DIR_MODE });
  if (lstatSync(uiDataDir).isSymbolicLink()) {
    throw Object.assign(new Error("the UI data directory is a link"), { code: "ELOOP" });
  }
}

function writeTemporaryFile(path: string, bytes: Buffer): string {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const fd = openSync(temporary, "wx", RUNTIME_STATE_FILE_MODE);
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return temporary;
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function publishFile(temporary: string, path: string, sink: SecurityLogSink | undefined): void {
  try {
    atomicPublishRename(temporary, path, sink === undefined ? {} : { securityLogSink: sink });
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function hasEnvValue(value: string | undefined): boolean {
  return value !== undefined && value.length > 0;
}

export interface ProvisionedConfigInput {
  readonly sourcePath: string;
  readonly stateDir: string;
  readonly env: EnvSource;
  /** A Keiko of this state directory is running: it holds its configuration in memory. */
  readonly running: boolean;
  readonly securityLogSink?: SecurityLogSink | undefined;
}

function writeCandidate(uiDataDir: string, bytes: Buffer): string {
  try {
    ensureUiDataDir(uiDataDir);
    return writeTemporaryFile(join(uiDataDir, GATEWAY_CONFIG_FILENAME), bytes);
  } catch (error) {
    throw new AdoptionEnded("write-failed", error);
  }
}

// The candidate must load through the loader the UI process reads its configuration with, on the
// exact bytes it will read. The loader's message would quote file content, so what is kept is the
// closed outcome and the error's class.
async function assertLoadsAsGatewayConfig(candidate: string, env: EnvSource): Promise<void> {
  const { loadConfigFromFile } = await loadModelGateway();
  try {
    loadConfigFromFile(candidate, env);
  } catch (error) {
    throw new AdoptionEnded("invalid", error);
  }
}

// Config first, marker second: a crash in between adopts the same bytes again on the next start,
// while the reverse order would record an adoption that never happened.
function publishAdoption(
  input: ProvisionedConfigInput,
  candidate: string,
  uiDataDir: string,
  sha256: string,
): void {
  const sink = input.securityLogSink;
  try {
    publishFile(candidate, join(uiDataDir, GATEWAY_CONFIG_FILENAME), sink);
  } catch (error) {
    throw new AdoptionEnded("write-failed", error);
  }
  const markerPath = join(uiDataDir, PROVISIONED_CONFIG_MARKER_FILENAME);
  try {
    publishFile(
      writeTemporaryFile(markerPath, Buffer.from(`${sha256}\n`, "utf8")),
      markerPath,
      sink,
    );
  } catch (error) {
    // The configuration is in force; only the record of it is missing, so the next start adopts
    // the same bytes again.
    throw new AdoptionEnded("marker-failed", error);
  }
}

async function replaceConfiguration(
  input: ProvisionedConfigInput,
  uiDataDir: string,
  bytes: Buffer,
  sha256: string,
): Promise<void> {
  const candidate = writeCandidate(uiDataDir, bytes);
  try {
    await assertLoadsAsGatewayConfig(candidate, input.env);
    publishAdoption(input, candidate, uiDataDir, sha256);
  } finally {
    // The candidate holds the key in plain text. Once published it no longer exists under this
    // name; on every other way out, including a loader that could not be loaded at all, it must
    // not stay behind.
    rmSync(candidate, { force: true });
  }
}

type AdoptionDecision = "adopted" | "unchanged" | "deferred-running" | "overridden";

async function decide(input: ProvisionedConfigInput): Promise<AdoptionDecision> {
  // An explicit config location belongs to whoever set it; the server reads that one, so a file
  // adopted into the state directory would silently not be the configuration in force.
  if (hasEnvValue(input.env.KEIKO_CONFIG_FILE) || hasEnvValue(input.env.KEIKO_UI_DATA_DIR)) {
    return "overridden";
  }
  const bytes = withoutByteOrderMark(readProvisionedFile(input.sourcePath));
  const uiDataDir = defaultUiDataDir(input.stateDir);
  const sha256 = sha256Hex(bytes);
  if (adoptedSha256(join(uiDataDir, PROVISIONED_CONFIG_MARKER_FILENAME)) === sha256) {
    return "unchanged";
  }
  if (input.running) return "deferred-running";
  await replaceConfiguration(input, uiDataDir, bytes, sha256);
  return "adopted";
}

/**
 * Adopts the provisioned configuration when it is new or changed. Exactly one activity line
 * records the outcome: the decision when the adoption ran to its end, otherwise the outcome and
 * cause of the step that ended it. It never throws into the start.
 */
export async function adoptProvisionedConfig(
  input: ProvisionedConfigInput,
): Promise<ProvisionedConfigResult> {
  let decision: AdoptionDecision;
  try {
    decision = await decide(input);
  } catch (error) {
    return recordEnded(input.securityLogSink, error);
  }
  return recordOutcome(input.securityLogSink, decision);
}

const OUTCOME_MESSAGES: Readonly<Partial<Record<ProvisionedConfigOutcome, string>>> = {
  adopted: "Keiko uses the configuration that came with this folder.",
  "deferred-running":
    "Keiko is already running with its earlier configuration. Stop Keiko and start it again to use the new one.",
  overridden:
    "An explicit configuration location is set, so the configuration in this folder is not used.",
  invalid:
    "The configuration in this folder is not a Keiko gateway configuration. Keiko keeps its current one; tell your administrator.",
  "too-large":
    "The configuration in this folder is too large to be one. Keiko keeps its current one; tell your administrator.",
  "refused-link":
    "The configuration in this folder is a link, which Keiko does not follow. Keiko keeps its current one; tell your administrator.",
  "read-failed":
    "The configuration in this folder could not be read. Keiko keeps its current one; tell your administrator.",
  "write-failed":
    "The configuration in this folder could not be saved. Keiko keeps its current one; start Keiko again, and tell your administrator if this stays.",
  "marker-failed":
    "Keiko uses the configuration that came with this folder, but could not note that it did, and will take it over again at the next start.",
};

/** What the person reads about the adoption; silent when nothing changed for them. */
export function provisionedConfigMessage(outcome: ProvisionedConfigOutcome): string | undefined {
  return OUTCOME_MESSAGES[outcome];
}
