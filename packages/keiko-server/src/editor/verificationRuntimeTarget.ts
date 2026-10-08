import { createHash } from "node:crypto";
import { DEFAULT_CONTAINER_IMAGE } from "@oscharko-dev/keiko-sandbox";
import {
  CommandCancelledError,
  DEFAULT_SANDBOX_POLICY,
  runCommand,
  type CommandResult,
  type CommandRule,
  type RunCommandDeps,
} from "@oscharko-dev/keiko-tools";
import { nodeSpawnFn } from "@oscharko-dev/keiko-tools/internal/exec";
import type { VerificationDeps } from "@oscharko-dev/keiko-verification";
import type { WorkspaceFs, WorkspaceInfo } from "@oscharko-dev/keiko-workspace";

type DependencyInstallTarget = NonNullable<VerificationDeps["dependencyInstallTarget"]>;
type RuntimeMetadata = Omit<DependencyInstallTarget, "runtimeIdentitySha256">;

// Only Node's own process/report metadata, never a repository module or an incoming command.
const RUNTIME_METADATA_SOURCE = [
  'const p = require("node:process");',
  'const r = p.platform === "linux" ? p.report.getReport() : undefined;',
  String.raw`const libc = p.platform !== "linux" ? "none" : typeof r.header.glibcVersionRuntime === "string" ? "glibc" : r.sharedObjects.some(x => /(?:^|\/)ld-musl-[^/]+\.so\.1$/.test(x)) ? "musl" : "unknown";`,
  String.raw`p.stdout.write(JSON.stringify({os:p.platform,cpu:p.arch,libc,nodeVersion:p.version,nodeAbi:p.versions.modules,napiVersion:p.versions.napi}) + "\n");`,
].join("\n");
const METADATA_ARGS = Object.freeze(["-e", RUNTIME_METADATA_SOURCE]);
const METADATA_RULES: readonly CommandRule[] = Object.freeze([
  {
    executable: "node",
    allowedSubcommands: Object.freeze([RUNTIME_METADATA_SOURCE]),
    requiredLeadingFlags: Object.freeze(["-e"]),
  },
]);
const METADATA_MAX_BYTES = 1_024;
const METADATA_TIMEOUT_MS = 15_000;
const METADATA_KEYS = new Set(["os", "cpu", "libc", "nodeVersion", "nodeAbi", "napiVersion"]);

export interface VerificationRuntimeTargetInput {
  readonly workspace: WorkspaceInfo;
  readonly signal: AbortSignal;
  readonly fs?: WorkspaceFs | undefined;
  readonly onTerminated?: RunCommandDeps["onTerminated"];
}

export async function resolveVerificationRuntimeTarget(
  input: VerificationRuntimeTargetInput,
): Promise<DependencyInstallTarget> {
  const result = await runCommand(
    {
      command: "node",
      args: METADATA_ARGS,
      cwd: undefined,
      timeoutMs: METADATA_TIMEOUT_MS,
      signal: input.signal,
    },
    {
      workspace: input.workspace,
      policy: {
        ...DEFAULT_SANDBOX_POLICY,
        network: "none",
        filesystem: "execution-root",
        maxOutputBytes: METADATA_MAX_BYTES,
        defaultTimeoutMs: METADATA_TIMEOUT_MS,
      },
      commandRules: METADATA_RULES,
      spawn: nodeSpawnFn,
      processEnv: process.env,
      now: Date.now,
      ...(input.fs === undefined ? {} : { fs: input.fs }),
      ...(input.onTerminated === undefined ? {} : { onTerminated: input.onTerminated }),
    },
  );
  if (input.signal.aborted) throw new CommandCancelledError("Runtime target probe cancelled");
  return runtimeTargetFromResult(result);
}

function runtimeTargetFromResult(result: CommandResult): DependencyInstallTarget {
  if (!usableCommandOutput(result) || !enforcedRuntime(result)) {
    throw new TypeError("VERIFICATION_RUNTIME_TARGET_UNAVAILABLE");
  }
  const metadata = parseRuntimeMetadata(result.stdout);
  const backend = result.attestation?.backend;
  const image =
    backend === "container-docker" || backend === "container-podman"
      ? DEFAULT_CONTAINER_IMAGE
      : undefined;
  return Object.freeze({
    ...metadata,
    runtimeIdentitySha256: createHash("sha256")
      .update(JSON.stringify({ backend, image, metadata }))
      .digest("hex"),
  });
}

function usableCommandOutput(result: CommandResult): boolean {
  return (
    result.exitCode === 0 &&
    result.signal === null &&
    !result.timedOut &&
    !result.truncated &&
    result.outputRedacted !== true &&
    result.stderr.length === 0 &&
    Buffer.byteLength(result.stdout) <= METADATA_MAX_BYTES
  );
}
function enforcedRuntime(result: CommandResult): boolean {
  return result.attestation?.networkEnforced === true && result.attestation.filesystemEnforced;
}

function parseRuntimeMetadata(text: string): RuntimeMetadata {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("VERIFICATION_RUNTIME_TARGET_INVALID");
  }
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).length !== METADATA_KEYS.size ||
    Object.keys(data).some((key) => !METADATA_KEYS.has(key)) ||
    !validPlatformData(data) ||
    !validRuntimeVersions(data)
  ) {
    throw new TypeError("VERIFICATION_RUNTIME_TARGET_INVALID");
  }
  return Object.freeze({
    os: data.os,
    cpu: data.cpu,
    libc: data.libc,
    nodeVersion: data.nodeVersion,
    nodeAbi: data.nodeAbi,
    napiVersion: data.napiVersion,
  });
}

function validPlatformData(
  data: Record<string, unknown>,
): data is Record<string, unknown> & Pick<RuntimeMetadata, "os" | "cpu" | "libc"> {
  return (
    (data.os === "linux" || data.os === "darwin" || data.os === "win32") &&
    (data.cpu === "arm64" || data.cpu === "x64") &&
    validLibc(data.os, data.libc)
  );
}

function validRuntimeVersions(
  data: Record<string, unknown>,
): data is Record<string, unknown> &
  Pick<RuntimeMetadata, "nodeVersion" | "nodeAbi" | "napiVersion"> {
  return (
    typeof data.nodeVersion === "string" &&
    /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(data.nodeVersion) &&
    boundedDecimal(data.nodeAbi) &&
    boundedDecimal(data.napiVersion)
  );
}

function validLibc(os: unknown, libc: unknown): libc is RuntimeMetadata["libc"] {
  return os === "linux" ? libc === "glibc" || libc === "musl" : libc === "none";
}

function boundedDecimal(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,4}$/u.test(value);
}
