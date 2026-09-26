import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, fstatSync, writeSync } from "node:fs";
import { access } from "node:fs/promises";
import { createConnection, createServer, type Server, Socket } from "node:net";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isLinuxGatewayDiagnosticKind,
  type LinuxGatewayDiagnosticKind,
} from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import type {
  LongLivedRuntimePlatform,
  LongLivedRuntimeQualification,
  RuntimeQualificationComponentDigest,
  RuntimeQualificationReceipt,
  RuntimeQualificationReceiptBinding,
  RuntimeQualificationReceiptResult,
  RuntimeQualificationSidecarDigest,
  RuntimeQualificationTarget,
} from "@oscharko-dev/keiko-contracts/runtime/runtime-qualification";

export function linuxGatewayLauncherPath(): string {
  return fileURLToPath(new URL("../dist/runtime.js", import.meta.url));
}

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
      platform: qualificationPlatform(candidate.platformTarget),
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
const LINUX_RECEIPT_KEYS = [...RECEIPT_KEYS, "runtimeComponents"] as const;
const RUNTIME_COMPONENT_NAMES = new Set(["node-runtime", "primary-launcher", "usearch"]);

function receiptIsClosed(value: unknown): value is RuntimeQualificationReceipt {
  if (!isRecord(value)) return false;
  const keys = value.platformTarget === "linux-x64" ? LINUX_RECEIPT_KEYS : RECEIPT_KEYS;
  if (!isExactRecord(value, keys)) return false;
  return receiptIdentityIsClosed(value) && receiptResultIsClosed(value);
}

function receiptIdentityIsClosed(value: Record<string, unknown>): boolean {
  const target = value.platformTarget;
  return (
    (target === "linux-x64" ? value.schemaVersion === 2 : value.schemaVersion === 1) &&
    value.suiteVersion === "runtime-tree-qualification-v1" &&
    isQualificationTarget(target) &&
    receiptCommitIsClosed(value.sourceCommitSha) &&
    receiptDigestsAreClosed(value) &&
    sidecarsAreClosed(value.sidecars) &&
    (target !== "linux-x64" || runtimeComponentsAreClosed(value.runtimeComponents))
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

function receiptResultIsClosed(value: Record<string, unknown>): boolean {
  const backend = value.backend;
  if (
    backend !== "linux-namespace-gateway" &&
    backend !== "windows-job-object" &&
    backend !== "macos-endpoint-security"
  ) {
    return false;
  }
  if (value.result !== "passed" && value.result !== "failed") return false;
  return isQualificationTarget(value.platformTarget)
    ? backendMatchesTarget({ backend, platformTarget: value.platformTarget })
    : false;
}

function bindingIsCurrent(
  receipt: RuntimeQualificationReceipt,
  binding: RuntimeQualificationReceiptBinding,
): boolean {
  if (!commonBindingMatches(receipt, binding)) return false;
  return runtimeComponentsMatch(receipt, binding);
}

function commonBindingMatches(
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

function runtimeComponentsMatch(
  receipt: RuntimeQualificationReceipt,
  binding: RuntimeQualificationReceiptBinding,
): boolean {
  if (receipt.platformTarget !== "linux-x64") return binding.runtimeComponents === undefined;
  return (
    binding.runtimeComponents !== undefined &&
    canonicalRuntimeComponents(receipt.runtimeComponents ?? []) ===
      canonicalRuntimeComponents(binding.runtimeComponents)
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

function runtimeComponentsAreClosed(
  value: unknown,
): value is readonly RuntimeQualificationComponentDigest[] {
  if (!Array.isArray(value) || value.length !== RUNTIME_COMPONENT_NAMES.size) return false;
  const names = new Set<string>();
  for (const entry of value) {
    if (!isExactRecord(entry, ["name", "sha256"])) return false;
    if (!RUNTIME_COMPONENT_NAMES.has(entry.name) || !DIGEST_PATTERN.test(entry.sha256))
      return false;
    names.add(entry.name);
  }
  return names.size === RUNTIME_COMPONENT_NAMES.size;
}

function canonicalReceipt(receipt: RuntimeQualificationReceipt): string {
  const common = {
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
  };
  return JSON.stringify(
    receipt.platformTarget === "linux-x64"
      ? {
          ...common,
          runtimeComponents: canonicalRuntimeComponentRecords(receipt.runtimeComponents ?? []),
        }
      : common,
  );
}

function canonicalSidecars(sidecars: readonly RuntimeQualificationSidecarDigest[]): string {
  return JSON.stringify(canonicalSidecarRecords(sidecars));
}

function canonicalSidecarRecords(
  sidecars: readonly RuntimeQualificationSidecarDigest[],
): readonly RuntimeQualificationSidecarDigest[] {
  return [...sidecars].sort((left, right) => left.name.localeCompare(right.name));
}

function canonicalRuntimeComponents(
  components: readonly RuntimeQualificationComponentDigest[],
): string {
  return JSON.stringify(canonicalRuntimeComponentRecords(components));
}

function canonicalRuntimeComponentRecords(
  components: readonly RuntimeQualificationComponentDigest[],
): readonly RuntimeQualificationComponentDigest[] {
  return [...components].sort((left, right) => left.name.localeCompare(right.name));
}

function backendMatchesTarget(
  receipt: Pick<RuntimeQualificationReceipt, "platformTarget" | "backend">,
): boolean {
  if (receipt.platformTarget === "windows-x64") {
    return receipt.backend === "windows-job-object";
  }
  if (receipt.platformTarget === "linux-x64") {
    return receipt.backend === "linux-namespace-gateway";
  }
  return receipt.backend === "macos-endpoint-security";
}

function isQualificationTarget(value: unknown): value is RuntimeQualificationTarget {
  return (
    value === "linux-x64" ||
    value === "windows-x64" ||
    value === "macos-arm64" ||
    value === "macos-x64"
  );
}

function qualificationPlatform(target: RuntimeQualificationTarget): LongLivedRuntimePlatform {
  if (target === "windows-x64") return "win32";
  if (target === "linux-x64") return "linux";
  return "darwin";
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
  return (
    windowsQualificationIsSupported(qualification) ||
    linuxQualificationIsSupported(qualification) ||
    macosQualificationIsSupported(qualification)
  );
}

type QualificationRecord = Record<"platform" | "arch" | "backend" | "releaseReceipt", string>;

function windowsQualificationIsSupported(
  qualification: QualificationRecord,
): qualification is LongLivedRuntimeQualification & QualificationRecord {
  return (
    qualification.platform === "win32" &&
    qualification.arch === "x64" &&
    qualification.backend === "windows-job-object"
  );
}

function linuxQualificationIsSupported(
  qualification: QualificationRecord,
): qualification is LongLivedRuntimeQualification & QualificationRecord {
  return (
    qualification.platform === "linux" &&
    qualification.arch === "x64" &&
    qualification.backend === "linux-namespace-gateway"
  );
}

function macosQualificationIsSupported(
  qualification: QualificationRecord,
): qualification is LongLivedRuntimeQualification & QualificationRecord {
  return (
    qualification.platform === "darwin" &&
    (qualification.arch === "arm64" || qualification.arch === "x64") &&
    (qualification.backend === "macos-app-sandbox" ||
      qualification.backend === "macos-endpoint-security")
  );
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

// Linux gateway bridge entry point (#3422). The host and namespace launchers share one anonymous
// Node IPC socketpair. The namespace asks for a stream by numeric id; the host connects only to the
// already-validated gateway and transfers that connected descriptor through the socketpair. There
// is no filesystem socket for a same-uid sidecar to discover or reuse across concurrent runs. This
// lives in the existing long-lived-runtime owner so the H1 dependency closure does not acquire a
// misleading new source identity for an implementation it already transitively governs.

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

interface Relay {
  readonly server: Server;
  readonly destroyConnections: () => void;
  readonly dispose: () => void;
}

interface HostBridge {
  readonly destroyConnections: () => void;
  readonly dispose: () => void;
}

interface ChildReference {
  current: ChildProcess | undefined;
  failure: LinuxGatewayDiagnosticKind | undefined;
}

interface BridgeReadyMessage {
  readonly kind: "ready";
}

interface BridgeOpenMessage {
  readonly kind: "open";
  readonly connectionId: number;
}

interface BridgeSocketMessage {
  readonly kind: "socket";
  readonly connectionId: number;
}

export const LINUX_GATEWAY_DIAGNOSTIC_FD_ENV = "KEIKO_LINUX_GATEWAY_DIAGNOSTIC_FD";
export const LINUX_GATEWAY_DIAGNOSTIC_FD = 3;
export const LINUX_GATEWAY_NAMESPACE_DIAGNOSTIC_FD = 9;
export const LINUX_GATEWAY_NAMESPACE_IPC_FD = 10;
const LINUX_GATEWAY_DIAGNOSTIC_PREFIX = "keiko-linux-gateway:error:";
const MAX_RELAY_CONNECTIONS = 64;

const SIGNALS: readonly ForwardedSignal[] = ["SIGINT", "SIGHUP", "SIGTERM"];
const LOOPBACK_TOOLS: readonly string[] = ["/usr/sbin/ip", "/sbin/ip", "/usr/bin/ip", "/bin/ip"];

class LinuxGatewayLauncherError extends Error {
  public constructor(public readonly errorKind: LinuxGatewayDiagnosticKind) {
    super(errorKind);
    this.name = "LinuxGatewayLauncherError";
  }
}

function fail(errorKind: LinuxGatewayDiagnosticKind): never {
  throw new LinuxGatewayLauncherError(errorKind);
}

function parseBackend(value: string | undefined): LinuxGatewayBackend {
  return value === "bubblewrap" || value === "unshare" ? value : fail("invalid-backend");
}

function parseGatewayHost(value: string | undefined): "127.0.0.1" | "::1" {
  return value === "127.0.0.1" || value === "::1" ? value : fail("invalid-gateway-host");
}

export function parseLinuxGatewayPort(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d{0,4}$/u.test(value)) {
    return fail("invalid-gateway-port");
  }
  const port = Number(value);
  return port <= 65_535 ? port : fail("invalid-gateway-port");
}

function parseAbsolute(
  value: string | undefined,
  errorKind: "invalid-command" | "invalid-cwd",
): string {
  return value !== undefined && isAbsolute(value) && !value.includes("\0")
    ? value
    : fail(errorKind);
}

function parseCommon(values: readonly string[], offset: number): CommonConfig {
  return {
    backend: parseBackend(values[offset]),
    gatewayHost: parseGatewayHost(values[offset + 1]),
    gatewayPort: parseLinuxGatewayPort(values[offset + 2]),
    cwd: parseAbsolute(values[offset + 3], "invalid-cwd"),
    command: parseAbsolute(values[offset + 4], "invalid-command"),
    args: values.slice(offset + 5),
  };
}

function parseNamespace(values: readonly string[]): CommonConfig {
  return parseCommon(values, 1);
}

function relaySockets(client: Socket, upstream: Socket, onUpstreamError: () => void): void {
  const close = (): void => {
    client.destroy();
    upstream.destroy();
  };
  client.once("error", close);
  upstream.once("error", () => {
    close();
    onUpstreamError();
  });
  client.pipe(upstream);
  upstream.pipe(client);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

function isBridgeReadyMessage(value: unknown): value is BridgeReadyMessage {
  return isRecord(value) && hasExactKeys(value, ["kind"]) && value.kind === "ready";
}

function isConnectionId(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function isBridgeOpenMessage(value: unknown): value is BridgeOpenMessage {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["kind", "connectionId"]) &&
    value.kind === "open" &&
    isConnectionId(value.connectionId)
  );
}

function isBridgeSocketMessage(value: unknown): value is BridgeSocketMessage {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["kind", "connectionId"]) &&
    value.kind === "socket" &&
    isConnectionId(value.connectionId)
  );
}

function destroySockets(sockets: ReadonlySet<Socket>): void {
  for (const socket of sockets) socket.destroy();
}

function transferGatewaySocket(
  child: ChildProcess,
  message: BridgeOpenMessage,
  socket: Socket,
  pending: Set<Socket>,
  onFatal: () => void,
): void {
  const failTransfer = (): void => {
    pending.delete(socket);
    socket.destroy();
    onFatal();
  };
  socket.once("error", failTransfer);
  socket.once("connect", () => {
    try {
      child.send({ kind: "socket", connectionId: message.connectionId }, socket, (error) => {
        pending.delete(socket);
        socket.off("error", failTransfer);
        if (error !== null) failTransfer();
      });
    } catch {
      failTransfer();
    }
  });
}

function createHostBridge(
  child: ChildProcess,
  config: CommonConfig,
  onFatal: () => void,
): HostBridge {
  const pending = new Set<Socket>();
  let ready = false;
  let lastConnectionId = 0;
  let active = true;
  const onMessage = (message: unknown, handle: unknown): void => {
    if (!active) return;
    if (handle !== undefined) {
      onFatal();
      return;
    }
    if (isBridgeReadyMessage(message) && !ready) {
      ready = true;
      return;
    }
    if (!ready || !isBridgeOpenMessage(message)) {
      onFatal();
      return;
    }
    if (message.connectionId <= lastConnectionId || pending.size >= MAX_RELAY_CONNECTIONS) {
      onFatal();
      return;
    }
    lastConnectionId = message.connectionId;
    const socket = createConnection({ host: config.gatewayHost, port: config.gatewayPort });
    pending.add(socket);
    transferGatewaySocket(child, message, socket, pending, onFatal);
  };
  child.on("message", onMessage);
  return {
    destroyConnections: (): void => {
      destroySockets(pending);
    },
    dispose: (): void => {
      active = false;
      child.off("message", onMessage);
      destroySockets(pending);
    },
  };
}

function sendBridgeOpen(message: BridgeOpenMessage, onFatal: () => void): void {
  const send = process.send?.bind(process);
  if (send === undefined) {
    onFatal();
    return;
  }
  try {
    send(message, (error) => {
      if (error !== null) onFatal();
    });
  } catch {
    onFatal();
  }
}

function receiveGatewaySocket(
  message: unknown,
  handle: unknown,
  pending: Map<number, Socket>,
  connections: Set<Socket>,
  onFatal: () => void,
): void {
  if (!isBridgeSocketMessage(message) || !(handle instanceof Socket)) {
    onFatal();
    return;
  }
  const client = pending.get(message.connectionId);
  if (client === undefined) {
    handle.destroy();
    return;
  }
  pending.delete(message.connectionId);
  connections.add(handle);
  handle.once("close", () => {
    connections.delete(handle);
  });
  relaySockets(client, handle, onFatal);
}

function namespaceRelay(onFatal: () => void): Relay {
  const pending = new Map<number, Socket>();
  const connections = new Set<Socket>();
  let nextConnectionId = 1;
  const server = createServer((client) => {
    if (pending.size >= MAX_RELAY_CONNECTIONS || !Number.isSafeInteger(nextConnectionId)) {
      client.destroy();
      onFatal();
      return;
    }
    const connectionId = nextConnectionId++;
    pending.set(connectionId, client);
    connections.add(client);
    client.once("close", () => {
      pending.delete(connectionId);
      connections.delete(client);
    });
    sendBridgeOpen({ kind: "open", connectionId }, onFatal);
  });
  const onMessage = (message: unknown, handle: unknown): void => {
    receiveGatewaySocket(message, handle, pending, connections, onFatal);
  };
  server.maxConnections = MAX_RELAY_CONNECTIONS;
  server.on("error", onFatal);
  process.on("message", onMessage);
  process.once("disconnect", onFatal);
  return {
    server,
    destroyConnections: (): void => {
      destroySockets(connections);
    },
    dispose: (): void => {
      process.off("message", onMessage);
      process.off("disconnect", onFatal);
    },
  };
}

function announceNamespaceReady(): Promise<void> {
  return new Promise((resolve, reject) => {
    const send = process.send?.bind(process);
    if (send === undefined) {
      reject(new Error("namespace-ipc-unavailable"));
      return;
    }
    try {
      send({ kind: "ready" }, (error) => {
        if (error === null) resolve();
        else reject(error);
      });
    } catch (error: unknown) {
      reject(error instanceof Error ? error : new Error("namespace-ipc-failed"));
    }
  });
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
  relay.dispose();
  if (!relay.server.listening) return Promise.resolve();
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

function terminateForRelayFailure(
  reference: ChildReference,
  failure: "host-relay-failed" | "namespace-relay-failed",
): void {
  if (reference.failure !== undefined) return;
  reference.failure = failure;
  reference.current?.kill("SIGKILL");
}

async function waitForChildOrRelayFailure(
  child: ChildProcess,
  reference: ChildReference,
): Promise<number> {
  const status = await waitForChild(child);
  return reference.failure === undefined ? status : fail(reference.failure);
}

type LinuxGatewayRunOutcome =
  | { readonly kind: "completed"; readonly status: number }
  | { readonly kind: "failed"; readonly error: unknown };

async function captureLinuxGatewayRun(run: () => Promise<number>): Promise<LinuxGatewayRunOutcome> {
  try {
    return { kind: "completed", status: await run() };
  } catch (error: unknown) {
    return { kind: "failed", error };
  }
}

async function cleanupFailure(cleanup: () => Promise<void>): Promise<boolean> {
  try {
    await cleanup();
    return false;
  } catch {
    return true;
  }
}

export async function runWithLinuxGatewayCleanup(
  run: () => Promise<number>,
  close: () => Promise<void>,
  remove: () => Promise<void>,
): Promise<number> {
  const outcome = await captureLinuxGatewayRun(run);
  const closeFailed = await cleanupFailure(close);
  const removeFailed = await cleanupFailure(remove);
  if (outcome.kind === "failed") throw outcome.error;
  if (closeFailed || removeFailed) return fail("cleanup-failed");
  return outcome.status;
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

function namespaceArgs(config: CommonConfig): readonly string[] {
  return [
    linuxGatewayLauncherPath(),
    "namespace",
    config.backend,
    config.gatewayHost,
    String(config.gatewayPort),
    config.cwd,
    config.command,
    ...config.args,
  ];
}

export function buildLinuxGatewayNamespaceCommand(
  config: CommonConfig,
): readonly [string, readonly string[]] {
  const launcher = [process.execPath, ...namespaceArgs(config)];
  if (config.backend === "bubblewrap") {
    // Bubblewrap passes unused inherited descriptors to its child. The caller reserves fds 3-8
    // and relocates diagnostics to fd 9 so Bubblewrap's low-numbered eventfds cannot collide.
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

function configuredDiagnosticFd(): number | undefined {
  const configured = process.env[LINUX_GATEWAY_DIAGNOSTIC_FD_ENV];
  if (configured === String(LINUX_GATEWAY_DIAGNOSTIC_FD)) return LINUX_GATEWAY_DIAGNOSTIC_FD;
  if (configured === String(LINUX_GATEWAY_NAMESPACE_DIAGNOSTIC_FD)) {
    return LINUX_GATEWAY_NAMESPACE_DIAGNOSTIC_FD;
  }
  return undefined;
}

function activeDiagnosticFd(): number | undefined {
  const fd = configuredDiagnosticFd();
  if (fd === undefined) return undefined;
  try {
    fstatSync(fd);
    return fd;
  } catch {
    return undefined;
  }
}

function nestedLauncherStdio(preserveDiagnosticFd: boolean): StdioOptions {
  return [
    "inherit",
    "inherit",
    "inherit",
    "ignore",
    "ignore",
    "ignore",
    "ignore",
    "ignore",
    "ignore",
    preserveDiagnosticFd ? LINUX_GATEWAY_DIAGNOSTIC_FD : "ignore",
    "ipc",
  ];
}

function nestedLauncherEnvironment(preserveDiagnosticFd: boolean): NodeJS.ProcessEnv {
  const environment = targetEnvironment();
  return preserveDiagnosticFd
    ? {
        ...environment,
        [LINUX_GATEWAY_DIAGNOSTIC_FD_ENV]: String(LINUX_GATEWAY_NAMESPACE_DIAGNOSTIC_FD),
      }
    : environment;
}

function targetEnvironment(): NodeJS.ProcessEnv {
  const privateNames = new Set([
    LINUX_GATEWAY_DIAGNOSTIC_FD_ENV,
    "NODE_CHANNEL_FD",
    "NODE_CHANNEL_SERIALIZATION_MODE",
  ]);
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !privateNames.has(name)),
  );
}

function targetStdio(): StdioOptions {
  return [
    "inherit",
    "inherit",
    "inherit",
    "ignore",
    "ignore",
    "ignore",
    "ignore",
    "ignore",
    "ignore",
    "ignore",
    "ignore",
  ];
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

async function runNamespace(config: CommonConfig): Promise<number> {
  if (config.backend === "unshare") await enableUnshareLoopback();
  const childReference: ChildReference = { current: undefined, failure: undefined };
  const relay = namespaceRelay(() => {
    terminateForRelayFailure(childReference, "namespace-relay-failed");
  });
  try {
    return await runWithLinuxGatewayCleanup(
      async () => {
        await listen(relay.server, { host: config.gatewayHost, port: config.gatewayPort });
        try {
          await announceNamespaceReady();
        } catch {
          return fail("namespace-relay-failed");
        }
        const child = spawn(config.command, config.args, {
          cwd: config.cwd,
          env: targetEnvironment(),
          stdio: targetStdio(),
        });
        childReference.current = child;
        const stopForwarding = forwardSignals(child);
        try {
          return await waitForChildOrRelayFailure(child, childReference);
        } finally {
          stopForwarding();
        }
      },
      () => closeRelay(relay),
      () => Promise.resolve(),
    );
  } finally {
    if (process.connected && process.disconnect !== undefined) process.disconnect();
  }
}

async function runHost(config: CommonConfig): Promise<number> {
  if (process.platform !== "linux") return fail("unsupported-platform");
  const childReference: ChildReference = { current: undefined, failure: undefined };
  const preserveDiagnosticFd = activeDiagnosticFd() === LINUX_GATEWAY_DIAGNOSTIC_FD;
  const [command, args] = buildLinuxGatewayNamespaceCommand(config);
  const child = spawn(command, args, {
    cwd: config.cwd,
    env: nestedLauncherEnvironment(preserveDiagnosticFd),
    stdio: nestedLauncherStdio(preserveDiagnosticFd),
  });
  childReference.current = child;
  const bridge = createHostBridge(child, config, () => {
    terminateForRelayFailure(childReference, "host-relay-failed");
  });
  const stopForwarding = forwardSignals(child);
  try {
    return await waitForChildOrRelayFailure(child, childReference);
  } finally {
    stopForwarding();
    bridge.destroyConnections();
    bridge.dispose();
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

export function linuxGatewayDiagnosticKind(error: unknown): LinuxGatewayDiagnosticKind {
  return error instanceof LinuxGatewayLauncherError ? error.errorKind : "internal-failure";
}

export function parseLinuxGatewayDiagnosticLine(
  line: string,
): LinuxGatewayDiagnosticKind | undefined {
  if (!line.startsWith(LINUX_GATEWAY_DIAGNOSTIC_PREFIX)) return undefined;
  const kind = line.slice(LINUX_GATEWAY_DIAGNOSTIC_PREFIX.length);
  return isLinuxGatewayDiagnosticKind(kind) ? kind : undefined;
}

function emitLinuxGatewayDiagnostic(kind: LinuxGatewayDiagnosticKind): void {
  const line = `${LINUX_GATEWAY_DIAGNOSTIC_PREFIX}${kind}\n`;
  const diagnosticFd = activeDiagnosticFd();
  if (diagnosticFd !== undefined) {
    try {
      writeSync(diagnosticFd, line, undefined, "utf8");
      return;
    } catch {
      // Fall back to the closed stderr protocol if the private parent channel was lost.
    }
  }
  process.stderr.write(line);
}

if (isMainModule()) {
  try {
    process.exitCode = await runLinuxGatewayLauncher(process.argv.slice(2));
  } catch (error: unknown) {
    emitLinuxGatewayDiagnostic(linuxGatewayDiagnosticKind(error));
    process.exitCode = 1;
  }
}
