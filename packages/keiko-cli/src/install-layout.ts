import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogEventEnvelope,
  type ActivityLogFields,
  type RegisteredActivityLogEvent,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";

const ROOT_PACKAGE_NAME = "@oscharko-dev/keiko";
export const INSTALL_LAYOUT_OVERRIDES_ENV = "KEIKO_INSTALL_LAYOUT_OVERRIDES";
export const INSTALL_LAYOUT_CORRELATION_ID_ENV = "KEIKO_INSTALL_LAYOUT_CORRELATION_ID";

const INSTALL_LAYOUT_OVERRIDE_KINDS = ["cli-bin", "ui-static-root", "local-state-auditor"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type InstallLayoutOverrideKind = (typeof INSTALL_LAYOUT_OVERRIDE_KINDS)[number];

export interface AuthoritativeInstallLayout {
  readonly cliBinPath: string;
  readonly uiStaticRoot: string;
  readonly localStateAuditor: string;
}

export interface InstallLayoutOverrideEvidence {
  readonly correlationId: string;
  readonly overriddenKinds: readonly InstallLayoutOverrideKind[];
}

export const INSTALL_LAYOUT_NORMALIZED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "cli.install-layout.normalized",
  category: "diagnostic",
  owner: "keiko-cli",
  emitter: "install-layout.installLayoutOverrideActivityLogEvent",
  fields: {
    overriddenCount: { type: "integer", dataClass: "count", required: true },
    overriddenKinds: {
      type: "string-array",
      dataClass: "closed-enum",
      required: true,
      values: ["cli-bin", "ui-static-root", "local-state-auditor"],
      maxItems: 3,
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["cli-install-layout-normalization"],
  proofIds: ["cli.install-layout.normalized-before-support-snapshot"],
  releaseImpact: "patch",
});

export type InstallLayoutNormalizedActivityLogEvent = RegisteredActivityLogEvent<
  typeof INSTALL_LAYOUT_NORMALIZED_OPERATION
> &
  ActivityLogEventEnvelope & {
    readonly extra: ActivityLogFields<typeof INSTALL_LAYOUT_NORMALIZED_OPERATION>;
  };

interface InstallLayoutEvidenceSink {
  readonly write: (event: InstallLayoutNormalizedActivityLogEvent) => void;
}

type InstallLayoutEvidenceSinkFactory = (stateDir: string) => InstallLayoutEvidenceSink;

interface InstallLayoutEntry {
  readonly envName: string;
  readonly kind: InstallLayoutOverrideKind;
  readonly value: string;
}

function installLayoutEntries(layout: AuthoritativeInstallLayout): readonly InstallLayoutEntry[] {
  return [
    { envName: "KEIKO_CLI_BIN_PATH", kind: "cli-bin", value: layout.cliBinPath },
    { envName: "KEIKO_UI_STATIC_ROOT", kind: "ui-static-root", value: layout.uiStaticRoot },
    {
      envName: "KEIKO_LOCAL_STATE_AUDITOR",
      kind: "local-state-auditor",
      value: layout.localStateAuditor,
    },
  ];
}

export function installLayoutOverrideEvidence(
  env: EnvSource,
): InstallLayoutOverrideEvidence | undefined {
  const correlationId = env[INSTALL_LAYOUT_CORRELATION_ID_ENV];
  const rawKinds = env[INSTALL_LAYOUT_OVERRIDES_ENV]?.split(",") ?? [];
  if (correlationId === undefined || !UUID.test(correlationId) || rawKinds.length === 0) {
    return undefined;
  }
  const requested = new Set(rawKinds);
  const overriddenKinds = INSTALL_LAYOUT_OVERRIDE_KINDS.filter((kind) => requested.has(kind));
  if (requested.size !== rawKinds.length || overriddenKinds.length !== requested.size) {
    return undefined;
  }
  return { correlationId, overriddenKinds };
}

export function installLayoutOverrideActivityLogEvent(
  evidence: InstallLayoutOverrideEvidence,
): InstallLayoutNormalizedActivityLogEvent {
  return activityLogEvent(
    INSTALL_LAYOUT_NORMALIZED_OPERATION,
    { level: "info", correlationId: evidence.correlationId },
    {
      overriddenCount: evidence.overriddenKinds.length,
      overriddenKinds: evidence.overriddenKinds,
    },
  );
}

export function writeInstallLayoutOverrideEvidence(
  sink: InstallLayoutEvidenceSink | undefined,
  env: EnvSource,
): boolean {
  const evidence = installLayoutOverrideEvidence(env);
  if (sink === undefined || evidence === undefined) return false;
  sink.write(installLayoutOverrideActivityLogEvent(evidence));
  Reflect.deleteProperty(env, INSTALL_LAYOUT_OVERRIDES_ENV);
  Reflect.deleteProperty(env, INSTALL_LAYOUT_CORRELATION_ID_ENV);
  return true;
}

export function writeInstallLayoutOverrideEvidenceWithFactory(
  factory: InstallLayoutEvidenceSinkFactory | undefined,
  stateDir: string,
  env: EnvSource,
): boolean {
  if (factory === undefined || installLayoutOverrideEvidence(env) === undefined) return false;
  return writeInstallLayoutOverrideEvidence(factory(stateDir), env);
}

export function applyAuthoritativeInstallLayout(
  env: NodeJS.ProcessEnv,
  layout: AuthoritativeInstallLayout,
): void {
  const entries = installLayoutEntries(layout);
  const inherited = entries.every((entry) => env[entry.envName] === entry.value)
    ? installLayoutOverrideEvidence(env)
    : undefined;
  const overriddenKinds =
    inherited?.overriddenKinds ??
    entries
      .filter((entry) => env[entry.envName] !== undefined && env[entry.envName] !== entry.value)
      .map((entry) => entry.kind);
  for (const entry of entries) env[entry.envName] = entry.value;
  if (overriddenKinds.length === 0) {
    Reflect.deleteProperty(env, INSTALL_LAYOUT_OVERRIDES_ENV);
    Reflect.deleteProperty(env, INSTALL_LAYOUT_CORRELATION_ID_ENV);
    return;
  }
  env[INSTALL_LAYOUT_OVERRIDES_ENV] = overriddenKinds.join(",");
  env[INSTALL_LAYOUT_CORRELATION_ID_ENV] = inherited?.correlationId ?? randomUUID();
}

export interface PreferredInstallLayout {
  readonly binPath: string;
  readonly staticRoot: string;
}

export interface LocalPackageInstallLayout extends PreferredInstallLayout {
  readonly packageRoot: string;
}

export type KeikoBinarySource = "local-build" | "local-package" | "env-override" | "argv" | "path";

export interface KeikoBinaryResolution {
  readonly binPath: string;
  readonly source: KeikoBinarySource;
}

interface RootPackageJson {
  readonly name?: unknown;
}

function readRootPackageName(cwd: string): string | undefined {
  const packageJsonPath = join(cwd, "package.json");
  if (!existsSync(packageJsonPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as RootPackageJson;
    return typeof parsed.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

export function hasBuiltKeikoLayout(root: string): boolean {
  return (
    existsSync(resolve(root, "dist", "cli", "index.js")) &&
    existsSync(resolve(root, "dist", "ui", "static", "index.html"))
  );
}

export function localPackageRoot(cwd: string): string {
  return resolve(cwd, "node_modules", "@oscharko-dev", "keiko");
}

function builtLayoutAt(root: string): PreferredInstallLayout | undefined {
  if (!hasBuiltKeikoLayout(root)) return undefined;
  return {
    binPath: resolve(root, "dist", "cli", "index.js"),
    staticRoot: resolve(root, "dist", "ui", "static"),
  };
}

function builtCheckoutLayout(cwd: string): PreferredInstallLayout | undefined {
  if (readRootPackageName(cwd) !== ROOT_PACKAGE_NAME) return undefined;
  return builtLayoutAt(cwd);
}

function localPackageLayout(cwd: string): LocalPackageInstallLayout | undefined {
  const packageRoot = localPackageRoot(cwd);
  const preferred = builtLayoutAt(packageRoot);
  if (preferred === undefined) return undefined;
  return { ...preferred, packageRoot };
}

export function resolvePreferredInstallLayout(cwd: string): PreferredInstallLayout | undefined {
  return builtCheckoutLayout(cwd) ?? localPackageLayout(cwd);
}

export function resolveKeikoBinary(
  cwd: string,
  env: EnvSource = process.env,
  argv: readonly string[] = process.argv,
): KeikoBinaryResolution | undefined {
  const checks: readonly {
    readonly source: KeikoBinarySource;
    readonly binPath: string | undefined;
  }[] = [
    // KEIKO-0553: `env` defaults to `process.env` at the parameter site (line above), so
    // an explicit caller-supplied EnvSource is authoritative — no per-key `?? process.env.X`
    // fallback here or the ambient shell leaks back into isolated tests and F5-style overrides.
    {
      source: "env-override",
      binPath: absoluteExistingPath(env.KEIKO_CLI_BIN_PATH),
    },
    { source: "argv", binPath: absoluteExistingPath(argv[1]) },
    { source: "local-build", binPath: builtCheckoutLayout(cwd)?.binPath },
    { source: "local-package", binPath: localPackageLayout(cwd)?.binPath },
  ];

  for (const candidate of checks) {
    if (candidate.binPath !== undefined) {
      return { source: candidate.source, binPath: candidate.binPath };
    }
  }

  const pathHit = resolveKeikoBinaryFromPath(process.platform, env.PATH);
  if (pathHit !== undefined) {
    return { source: "path", binPath: pathHit };
  }
  return undefined;
}

export function absoluteExistingPath(value: unknown): string | undefined {
  return typeof value === "string" && isAbsolute(value) && existsSync(value) ? value : undefined;
}

function resolveKeikoBinaryFromPath(
  platform: NodeJS.Platform,
  pathValue: unknown,
): string | undefined {
  if (typeof pathValue !== "string" || pathValue.length === 0) return undefined;
  const delimiter = platform === "win32" ? ";" : ":";
  const names = platform === "win32" ? ["keiko.cmd", "keiko.exe", "keiko.bat", "keiko"] : ["keiko"];
  return pathValue
    .split(delimiter)
    .flatMap((directory) => names.map((name) => join(directory, name)))
    .find((candidate) => existsSync(candidate));
}
