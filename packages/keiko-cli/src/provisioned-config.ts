// Adoption of an administrator-provisioned gateway configuration at `keiko start` (ADR-0121 D9).
//
// An administrator prepares one `keiko.config.json` for a group of people and ships it next to the
// start files of a standalone folder package. `keiko start --provisioned-config PATH` adopts that
// file as this installation's gateway configuration whenever its bytes differ from the last file
// adopted here, so a rotated key or a changed gateway arrives with the next package and needs no
// action from the person. The file is authoritative: it replaces the configuration as a whole.
//
// The provisioned file may carry a plaintext `apiKey`. It is an administrator-owned input outside
// Keiko's custody; the copy adopted into the state directory is sealed by the existing startup
// migration (ADR-0046 D4) on the same start. Nothing here reads, logs or reports the content: the
// activity line carries the closed outcome and an error class only.

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
import { dirname, join } from "node:path";
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

const FAILURE_OUTCOMES = [
  "invalid",
  "too-large",
  "refused-link",
  "read-failed",
  "write-failed",
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

type ReadResult =
  | { readonly status: "ok"; readonly bytes: Buffer }
  | { readonly status: "failed"; readonly result: ProvisionedConfigResult };

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function failedRead(outcome: ProvisionedConfigOutcome, error?: unknown): ReadResult {
  return { status: "failed", result: error === undefined ? { outcome } : { outcome, error } };
}

function classifyOpenError(error: unknown): ReadResult {
  const code = errorCode(error);
  if (code === "ENOENT") return failedRead("absent");
  // ELOOP is what O_NOFOLLOW answers for a link; a link names bytes outside the package folder.
  if (code === "ELOOP") return failedRead("refused-link", error);
  return failedRead("read-failed", error);
}

function readDescriptor(fd: number): ReadResult {
  const stat = fstatSync(fd);
  if (!stat.isFile()) return failedRead("invalid");
  if (stat.size > PROVISIONED_CONFIG_MAX_BYTES) return failedRead("too-large");
  const bytes = Buffer.alloc(stat.size);
  let filled = 0;
  while (filled < bytes.byteLength) {
    const read = readSync(fd, bytes, filled, bytes.byteLength - filled, filled);
    if (read === 0) break;
    filled += read;
  }
  // A file that changed size while it was read is not the file that was measured.
  return filled === bytes.byteLength ? { status: "ok", bytes } : failedRead("read-failed");
}

function readProvisionedFile(path: string): ReadResult {
  let fd: number;
  try {
    // lstat first: Windows has no O_NOFOLLOW, and a link must be refused on every platform.
    if (lstatSync(path).isSymbolicLink()) return failedRead("refused-link");
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    return classifyOpenError(error);
  }
  try {
    return readDescriptor(fd);
  } catch (error) {
    return failedRead("read-failed", error);
  } finally {
    closeSync(fd);
  }
}

function isGatewayConfigShape(bytes: Buffer): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    // The closed outcome `invalid` is the record; a parser message would quote file content.
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const providers: unknown = (parsed as { readonly providers?: unknown }).providers;
  return Array.isArray(providers) && providers.length > 0;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function adoptedSha256(markerPath: string): string | undefined {
  try {
    if (lstatSync(markerPath).size > MARKER_MAX_BYTES) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(markerPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const sha256: unknown = (parsed as { readonly sha256?: unknown }).sha256;
    return typeof sha256 === "string" && SHA256_PATTERN.test(sha256) ? sha256 : undefined;
  } catch {
    // No readable marker means "nothing adopted yet": the file is adopted again, which is
    // idempotent, and that adoption is the recorded event.
    return undefined;
  }
}

function writePrivateFile(path: string, bytes: Buffer, sink: SecurityLogSink | undefined): void {
  mkdirSync(dirname(path), { recursive: true, mode: RUNTIME_STATE_DIR_MODE });
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const fd = openSync(temporary, "wx", RUNTIME_STATE_FILE_MODE);
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    atomicPublishRename(temporary, path, sink === undefined ? {} : { securityLogSink: sink });
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function markerBytes(sha256: string): Buffer {
  return Buffer.from(`${JSON.stringify({ schemaVersion: 1, sha256 }, null, 2)}\n`, "utf8");
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

function decide(input: ProvisionedConfigInput): ProvisionedConfigResult {
  // An explicit config location belongs to whoever set it; the server reads that one, so a file
  // adopted into the state directory would silently not be the configuration in force.
  if (hasEnvValue(input.env.KEIKO_CONFIG_FILE) || hasEnvValue(input.env.KEIKO_UI_DATA_DIR)) {
    return { outcome: "overridden" };
  }
  const read = readProvisionedFile(input.sourcePath);
  if (read.status === "failed") return read.result;
  if (!isGatewayConfigShape(read.bytes)) return { outcome: "invalid" };
  const uiDataDir = defaultUiDataDir(input.stateDir);
  const markerPath = join(uiDataDir, PROVISIONED_CONFIG_MARKER_FILENAME);
  const sha256 = sha256Hex(read.bytes);
  if (adoptedSha256(markerPath) === sha256) return { outcome: "unchanged" };
  if (input.running) return { outcome: "deferred-running" };
  try {
    // Config first, marker second: a crash in between adopts the same bytes again on the next
    // start. The reverse order would record an adoption that never happened.
    writePrivateFile(join(uiDataDir, GATEWAY_CONFIG_FILENAME), read.bytes, input.securityLogSink);
    writePrivateFile(markerPath, markerBytes(sha256), input.securityLogSink);
    return { outcome: "adopted" };
  } catch (error) {
    return { outcome: "write-failed", error };
  }
}

/** Adopts the provisioned configuration when it is new or changed, and records the outcome. */
export function adoptProvisionedConfig(input: ProvisionedConfigInput): ProvisionedConfigResult {
  const result = decide(input);
  emitProvisionedConfig(input.securityLogSink, result);
  return result;
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
};

/** What the person reads about the adoption; silent when nothing changed for them. */
export function provisionedConfigMessage(outcome: ProvisionedConfigOutcome): string | undefined {
  return OUTCOME_MESSAGES[outcome];
}
