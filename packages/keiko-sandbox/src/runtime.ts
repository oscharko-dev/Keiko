import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LINUX_GATEWAY_LAUNCHER_PATH = fileURLToPath(
  new URL("../dist/runtime.js", import.meta.url),
);

export type LongLivedRuntimePlatform = "darwin" | "win32";
export type LongLivedRuntimeArchitecture = "arm64" | "x64";
export type LongLivedRuntimeBackend =
  "macos-app-sandbox" | "macos-endpoint-security" | "windows-job-object";

export interface LongLivedRuntimeQualification {
  readonly platform: LongLivedRuntimePlatform;
  readonly arch: LongLivedRuntimeArchitecture;
  readonly backend: LongLivedRuntimeBackend;
  readonly releaseReceipt: string;
}

export type RuntimeQualificationTarget = "windows-x64" | "macos-arm64" | "macos-x64";

export interface RuntimeQualificationSidecarDigest {
  readonly name: string;
  readonly sha256: string;
}

export interface RuntimeQualificationReceipt {
  readonly schemaVersion: 1;
  readonly suiteVersion: "runtime-tree-qualification-v1";
  readonly platformTarget: RuntimeQualificationTarget;
  readonly sourceCommitSha: string;
  readonly activationManifestSha256: string;
  readonly supervisorSha256: string;
  readonly secureReadSha256: string;
  readonly sidecars: readonly RuntimeQualificationSidecarDigest[];
  readonly backend: LongLivedRuntimeBackend;
  readonly result: "passed" | "failed";
}

export type RuntimeQualificationReceiptBinding = Omit<
  RuntimeQualificationReceipt,
  "schemaVersion" | "suiteVersion" | "backend" | "result"
>;

export type RuntimeQualificationReceiptResult =
  | { readonly ok: true; readonly qualification: LongLivedRuntimeQualification }
  | { readonly ok: false; readonly reason: "runtime-unqualified" };

export interface ClosedRuntimeLaunchProfile {
  readonly upstreamEditAuthority: false;
  readonly upstreamShellAuthority: false;
  readonly upstreamGitAuthority: false;
  readonly upstreamDeliveryAuthority: false;
  readonly upstreamConnectorAuthority: false;
  readonly upstreamBrowserAuthority: false;
  readonly unrestrictedNetworkAuthority: false;
}

export const CLOSED_RUNTIME_LAUNCH_PROFILE: ClosedRuntimeLaunchProfile = Object.freeze({
  upstreamEditAuthority: false,
  upstreamShellAuthority: false,
  upstreamGitAuthority: false,
  upstreamDeliveryAuthority: false,
  upstreamConnectorAuthority: false,
  upstreamBrowserAuthority: false,
  unrestrictedNetworkAuthority: false,
});

export const PRODUCTION_RUNTIME_QUALIFICATIONS: readonly LongLivedRuntimeQualification[] =
  Object.freeze([]);

export type LongLivedRuntimeQualificationResult =
  | {
      readonly ok: true;
      readonly qualification: LongLivedRuntimeQualification;
      readonly launchProfile: ClosedRuntimeLaunchProfile;
    }
  | { readonly ok: false; readonly reason: "runtime-unqualified" };

export function qualifyLongLivedRuntime(
  requested: LongLivedRuntimeQualification,
  qualifications: readonly LongLivedRuntimeQualification[] = PRODUCTION_RUNTIME_QUALIFICATIONS,
): LongLivedRuntimeQualificationResult {
  const qualification = qualifications.find((entry) => qualificationMatches(entry, requested));
  return qualification === undefined
    ? { ok: false, reason: "runtime-unqualified" }
    : { ok: true, qualification, launchProfile: CLOSED_RUNTIME_LAUNCH_PROFILE };
}

export function qualificationFromReceipt(
  candidate: unknown,
  binding: RuntimeQualificationReceiptBinding,
): RuntimeQualificationReceiptResult {
  if (!receiptIsClosed(candidate) || !bindingIsCurrent(candidate, binding)) {
    return { ok: false, reason: "runtime-unqualified" };
  }
  const releaseReceipt = `sha256:${createHash("sha256")
    .update(canonicalReceipt(candidate), "utf8")
    .digest("hex")}`;
  return {
    ok: true,
    qualification: {
      platform: candidate.platformTarget === "windows-x64" ? "win32" : "darwin",
      arch: candidate.platformTarget === "macos-arm64" ? "arm64" : "x64",
      backend: candidate.backend,
      releaseReceipt,
    },
  };
}

function qualificationMatches(
  qualification: LongLivedRuntimeQualification,
  requested: LongLivedRuntimeQualification,
): boolean {
  return (
    qualificationIsSupported(qualification) &&
    qualificationIsSupported(requested) &&
    qualification.platform === requested.platform &&
    qualification.arch === requested.arch &&
    qualification.backend === requested.backend &&
    qualification.releaseReceipt === requested.releaseReceipt
  );
}

const RELEASE_RECEIPT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SIDECAR_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const RECEIPT_KEYS = [
  "schemaVersion",
  "suiteVersion",
  "platformTarget",
  "sourceCommitSha",
  "activationManifestSha256",
  "supervisorSha256",
  "secureReadSha256",
  "sidecars",
  "backend",
  "result",
] as const;

function receiptIsClosed(value: unknown): value is RuntimeQualificationReceipt {
  if (!isExactRecord(value, RECEIPT_KEYS)) return false;
  return receiptIdentityIsClosed(value) && receiptResultIsClosed(value);
}

function receiptIdentityIsClosed(
  value: Record<(typeof RECEIPT_KEYS)[number], unknown>,
): value is Record<(typeof RECEIPT_KEYS)[number], unknown> &
  Pick<
    RuntimeQualificationReceipt,
    | "schemaVersion"
    | "suiteVersion"
    | "platformTarget"
    | "sourceCommitSha"
    | "activationManifestSha256"
    | "supervisorSha256"
    | "secureReadSha256"
    | "sidecars"
  > {
  return (
    value.schemaVersion === 1 &&
    value.suiteVersion === "runtime-tree-qualification-v1" &&
    isQualificationTarget(value.platformTarget) &&
    receiptCommitIsClosed(value.sourceCommitSha) &&
    receiptDigestsAreClosed(value) &&
    sidecarsAreClosed(value.sidecars)
  );
}

function receiptCommitIsClosed(value: unknown): value is string {
  return typeof value === "string" && COMMIT_PATTERN.test(value);
}

function receiptDigestsAreClosed(
  value: Record<string, unknown>,
): value is Record<string, unknown> &
  Pick<
    RuntimeQualificationReceipt,
    "activationManifestSha256" | "supervisorSha256" | "secureReadSha256"
  > {
  return (
    digestIsClosed(value.activationManifestSha256) &&
    digestIsClosed(value.supervisorSha256) &&
    digestIsClosed(value.secureReadSha256)
  );
}

function digestIsClosed(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function receiptResultIsClosed(
  value: ReturnTypeNarrowedReceipt,
): value is RuntimeQualificationReceipt {
  const backend = value.backend;
  if (backend !== "windows-job-object" && backend !== "macos-endpoint-security") return false;
  if (value.result !== "passed" && value.result !== "failed") return false;
  return backendMatchesTarget({ backend, platformTarget: value.platformTarget });
}

type ReturnTypeNarrowedReceipt = Record<(typeof RECEIPT_KEYS)[number], unknown> &
  Pick<RuntimeQualificationReceipt, "platformTarget">;

function bindingIsCurrent(
  receipt: RuntimeQualificationReceipt,
  binding: RuntimeQualificationReceiptBinding,
): boolean {
  return (
    receipt.result === "passed" &&
    receipt.platformTarget === binding.platformTarget &&
    receipt.sourceCommitSha === binding.sourceCommitSha &&
    receipt.activationManifestSha256 === binding.activationManifestSha256 &&
    receipt.supervisorSha256 === binding.supervisorSha256 &&
    receipt.secureReadSha256 === binding.secureReadSha256 &&
    canonicalSidecars(receipt.sidecars) === canonicalSidecars(binding.sidecars)
  );
}

function sidecarsAreClosed(value: unknown): value is readonly RuntimeQualificationSidecarDigest[] {
  if (!Array.isArray(value) || value.length > 8) return false;
  const names = new Set<string>();
  for (const entry of value) {
    if (!isExactRecord(entry, ["name", "sha256"])) return false;
    if (!SIDECAR_NAME_PATTERN.test(entry.name) || !DIGEST_PATTERN.test(entry.sha256)) return false;
    if (names.has(entry.name)) return false;
    names.add(entry.name);
  }
  return true;
}

function canonicalReceipt(receipt: RuntimeQualificationReceipt): string {
  return JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    suiteVersion: receipt.suiteVersion,
    platformTarget: receipt.platformTarget,
    sourceCommitSha: receipt.sourceCommitSha,
    activationManifestSha256: receipt.activationManifestSha256,
    supervisorSha256: receipt.supervisorSha256,
    secureReadSha256: receipt.secureReadSha256,
    sidecars: canonicalSidecarRecords(receipt.sidecars),
    backend: receipt.backend,
    result: receipt.result,
  });
}

function canonicalSidecars(sidecars: readonly RuntimeQualificationSidecarDigest[]): string {
  return JSON.stringify(canonicalSidecarRecords(sidecars));
}

function canonicalSidecarRecords(
  sidecars: readonly RuntimeQualificationSidecarDigest[],
): readonly RuntimeQualificationSidecarDigest[] {
  return [...sidecars].sort((left, right) => left.name.localeCompare(right.name));
}

function backendMatchesTarget(
  receipt: Pick<RuntimeQualificationReceipt, "platformTarget" | "backend">,
): boolean {
  return receipt.platformTarget === "windows-x64"
    ? receipt.backend === "windows-job-object"
    : receipt.backend === "macos-endpoint-security";
}

function isQualificationTarget(value: unknown): value is RuntimeQualificationTarget {
  return value === "windows-x64" || value === "macos-arm64" || value === "macos-x64";
}

function isExactRecord<const K extends string>(
  value: unknown,
  keys: readonly K[],
): value is Record<K, never> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function qualificationIsSupported(
  qualification: unknown,
): qualification is LongLivedRuntimeQualification {
  if (!isQualificationRecord(qualification)) return false;
  if (!RELEASE_RECEIPT_PATTERN.test(qualification.releaseReceipt)) return false;
  if (qualification.platform === "win32") {
    return qualification.arch === "x64" && qualification.backend === "windows-job-object";
  }
  if (qualification.platform === "darwin") {
    return (
      (qualification.arch === "arm64" || qualification.arch === "x64") &&
      (qualification.backend === "macos-app-sandbox" ||
        qualification.backend === "macos-endpoint-security")
    );
  }
  return false;
}

function isQualificationRecord(
  value: unknown,
): value is Record<"platform" | "arch" | "backend" | "releaseReceipt", string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = ["platform", "arch", "backend", "releaseReceipt"];
  return (
    Object.keys(record).length === keys.length &&
    keys.every((key) => typeof record[key] === "string")
  );
}

// Linux gateway bridge entry point (#3422). The host process owns one private Unix socket whose
// relay destination is fixed before the isolated child starts. A second copy of this entry point
// runs inside the fresh network namespace, exposes the attested loopback port there, and forwards
// every accepted stream through that Unix socket. No child-controlled value can select another
// host destination. It lives in this existing long-lived-runtime owner so the H1 dependency closure
// does not acquire a misleading new source identity for an implementation it already transitively
// governs.

type LinuxGatewayBackend = "bubblewrap" | "unshare";
type ForwardedSignal = "SIGINT" | "SIGHUP" | "SIGTERM";

interface CommonConfig {
  readonly backend: LinuxGatewayBackend;
  readonly gatewayHost: "127.0.0.1" | "::1";
  readonly gatewayPort: number;
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
}

interface NamespaceConfig extends CommonConfig {
  readonly socketPath: string;
}

interface Relay {
  readonly server: Server;
  readonly destroyConnections: () => void;
}

interface ChildReference {
  current: ChildProcess | undefined;
}

const SIGNALS: readonly ForwardedSignal[] = ["SIGINT", "SIGHUP", "SIGTERM"];
const LOOPBACK_TOOLS: readonly string[] = ["/usr/sbin/ip", "/sbin/ip", "/usr/bin/ip", "/bin/ip"];

class LinuxGatewayLauncherError extends Error {
  public constructor(public readonly errorKind: string) {
    super(errorKind);
    this.name = "LinuxGatewayLauncherError";
  }
}

function fail(errorKind: string): never {
  throw new LinuxGatewayLauncherError(errorKind);
}

function parseBackend(value: string | undefined): LinuxGatewayBackend {
  return value === "bubblewrap" || value === "unshare" ? value : fail("invalid-backend");
}

function parseGatewayHost(value: string | undefined): "127.0.0.1" | "::1" {
  return value === "127.0.0.1" || value === "::1" ? value : fail("invalid-gateway-host");
}

function parseGatewayPort(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d{0,4}$/u.test(value)) {
    return fail("invalid-gateway-port");
  }
  const port = Number(value);
  return port <= 65_535 ? port : fail("invalid-gateway-port");
}

function parseAbsolute(value: string | undefined, errorKind: string): string {
  return value !== undefined && isAbsolute(value) && !value.includes("\0")
    ? value
    : fail(errorKind);
}

function parseCommon(values: readonly string[], offset: number): CommonConfig {
  return {
    backend: parseBackend(values[offset]),
    gatewayHost: parseGatewayHost(values[offset + 1]),
    gatewayPort: parseGatewayPort(values[offset + 2]),
    cwd: parseAbsolute(values[offset + 3], "invalid-cwd"),
    command: parseAbsolute(values[offset + 4], "invalid-command"),
    args: values.slice(offset + 5),
  };
}

function parseNamespace(values: readonly string[]): NamespaceConfig {
  return {
    backend: parseBackend(values[1]),
    gatewayHost: parseGatewayHost(values[2]),
    gatewayPort: parseGatewayPort(values[3]),
    socketPath: parseAbsolute(values[4], "invalid-socket-path"),
    cwd: parseAbsolute(values[5], "invalid-cwd"),
    command: parseAbsolute(values[6], "invalid-command"),
    args: values.slice(7),
  };
}

function relaySockets(client: Socket, upstream: Socket): void {
  const close = (): void => {
    client.destroy();
    upstream.destroy();
  };
  client.once("error", close);
  upstream.once("error", close);
  client.pipe(upstream);
  upstream.pipe(client);
}

function createRelay(connectUpstream: () => Socket, onFatal: () => void): Relay {
  const connections = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connectUpstream();
    connections.add(client);
    connections.add(upstream);
    client.once("close", () => connections.delete(client));
    upstream.once("close", () => connections.delete(upstream));
    relaySockets(client, upstream);
  });
  server.maxConnections = 64;
  server.on("error", onFatal);
  return {
    server,
    destroyConnections: (): void => {
      for (const connection of connections) connection.destroy();
    },
  };
}

function hostRelay(config: CommonConfig, onFatal: () => void): Relay {
  return createRelay(
    () => createConnection({ host: config.gatewayHost, port: config.gatewayPort }),
    onFatal,
  );
}

function namespaceRelay(config: NamespaceConfig, onFatal: () => void): Relay {
  return createRelay(() => createConnection(config.socketPath), onFatal);
}

function listen(
  server: Server,
  target: string | { readonly host: string; readonly port: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(target);
  });
}

function closeRelay(relay: Relay): Promise<void> {
  relay.destroyConnections();
  return new Promise((resolve, reject) => {
    relay.server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

function waitForChild(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve(code ?? 1);
    });
  });
}

function forwardSignals(child: ChildProcess): () => void {
  const listeners = SIGNALS.map((signal) => {
    const listener = (): void => {
      child.kill(signal);
    };
    process.on(signal, listener);
    return { signal, listener };
  });
  return (): void => {
    for (const { signal, listener } of listeners) process.off(signal, listener);
  };
}

function namespaceArgs(config: CommonConfig, socketPath: string): readonly string[] {
  return [
    LINUX_GATEWAY_LAUNCHER_PATH,
    "namespace",
    config.backend,
    config.gatewayHost,
    String(config.gatewayPort),
    socketPath,
    config.cwd,
    config.command,
    ...config.args,
  ];
}

export function buildLinuxGatewayNamespaceCommand(
  config: CommonConfig,
  socketPath: string,
): readonly [string, readonly string[]] {
  const launcher = [process.execPath, ...namespaceArgs(config, socketPath)];
  if (config.backend === "bubblewrap") {
    return [
      "bwrap",
      [
        "--unshare-net",
        "--die-with-parent",
        "--new-session",
        "--dev-bind",
        "/",
        "/",
        "--chdir",
        config.cwd,
        "--",
        ...launcher,
      ],
    ];
  }
  return ["unshare", ["--map-root-user", "--net", "--kill-child=SIGKILL", "--", ...launcher]];
}

async function executableLoopbackTool(): Promise<string> {
  for (const candidate of LOOPBACK_TOOLS) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the closed, system-owned candidate list.
    }
  }
  return fail("loopback-tool-unavailable");
}

async function enableUnshareLoopback(): Promise<void> {
  const command = await executableLoopbackTool();
  const child = spawn(command, ["link", "set", "lo", "up"], { stdio: "ignore" });
  if ((await waitForChild(child)) !== 0) fail("loopback-setup-failed");
}

async function runNamespace(config: NamespaceConfig): Promise<number> {
  if (config.backend === "unshare") await enableUnshareLoopback();
  const childReference: ChildReference = { current: undefined };
  const relay = namespaceRelay(config, () => {
    childReference.current?.kill("SIGKILL");
  });
  await listen(relay.server, { host: config.gatewayHost, port: config.gatewayPort });
  const child = spawn(config.command, config.args, { cwd: config.cwd, stdio: "inherit" });
  childReference.current = child;
  const stopForwarding = forwardSignals(child);
  try {
    return await waitForChild(child);
  } finally {
    stopForwarding();
    await closeRelay(relay);
  }
}

async function runHost(config: CommonConfig): Promise<number> {
  if (process.platform !== "linux") return fail("unsupported-platform");
  const directory = await mkdtemp(join(tmpdir(), "keiko-gateway-"));
  const socketPath = join(directory, "relay.sock");
  const childReference: ChildReference = { current: undefined };
  const relay = hostRelay(config, () => {
    childReference.current?.kill("SIGKILL");
  });
  try {
    await chmod(directory, 0o700);
    await listen(relay.server, socketPath);
    await chmod(socketPath, 0o600);
    const [command, args] = buildLinuxGatewayNamespaceCommand(config, socketPath);
    const child = spawn(command, args, { cwd: config.cwd, stdio: "inherit" });
    childReference.current = child;
    const stopForwarding = forwardSignals(child);
    try {
      return await waitForChild(child);
    } finally {
      stopForwarding();
    }
  } finally {
    if (relay.server.listening) await closeRelay(relay);
    await rm(directory, { recursive: true, force: true });
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

export async function runLinuxGatewayLauncher(values: readonly string[]): Promise<number> {
  if (values[0] === "host") return runHost(parseCommon(values, 1));
  if (values[0] === "namespace") return runNamespace(parseNamespace(values));
  return fail("invalid-mode");
}

export function linuxGatewayDiagnosticKind(error: unknown): string {
  return error instanceof LinuxGatewayLauncherError ? error.errorKind : "internal-failure";
}

if (isMainModule()) {
  try {
    process.exitCode = await runLinuxGatewayLauncher(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`keiko-linux-gateway:error:${linuxGatewayDiagnosticKind(error)}\n`);
    process.exitCode = 1;
  }
}
