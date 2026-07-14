import { createHash } from "node:crypto";
import { delimiter, isAbsolute, posix } from "node:path";

const MAX_COLLECTION_ENTRIES = 128;
const MAX_STRING_LENGTH = 4_096;
const NPM_GLOBAL_CONFIG_PATH = "/opt/keiko-debug/npm-global-config";
const NPM_USER_CONFIG_PATH = "/opt/keiko-debug/npm-user-config";
const PROTECTED_ENVIRONMENT_NAMES = new Set([
  "HOME",
  "PATH",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
]);

export interface DapOperatorProvisionedArtifact {
  readonly hostPath: string;
  readonly approvedRoot: string;
  readonly capsulePath: string;
}

export interface DapOperatorAdapterProvisioning {
  readonly executableName: string;
  readonly executableArgs: readonly string[];
  readonly trustedRoots: readonly string[];
  readonly approvedPath: string;
  readonly envAllowlist: readonly string[];
  readonly fixedEnv: Readonly<Record<string, string>>;
  /** A content-free identity derived from the normalized declarative document. */
  readonly provisioningDigest: string;
}

export interface DapOperatorLaunchProvisioning {
  readonly adapterApprovedRoot: string;
  readonly node: DapOperatorProvisionedArtifact;
  readonly npm: DapOperatorProvisionedArtifact;
  readonly shell: DapOperatorProvisionedArtifact;
  readonly npmUserConfig: DapOperatorProvisionedArtifact;
  readonly npmGlobalConfig: DapOperatorProvisionedArtifact;
  readonly backend: DapOperatorProvisionedArtifact;
  readonly runtimeClosure: readonly DapOperatorProvisionedArtifact[];
  readonly containerImage?: string | undefined;
}

export interface DapOperatorProvisioningDocument {
  readonly schemaVersion: 1;
  readonly adapter: DapOperatorAdapterProvisioning;
  readonly launch: DapOperatorLaunchProvisioning;
}

export type ParseDapOperatorProvisioningResult =
  | { readonly ok: true; readonly value: DapOperatorProvisioningDocument }
  | {
      readonly ok: false;
      readonly error: { readonly code: "INVALID_DAP_OPERATOR_PROVISIONING" };
    };

type UnknownRecord = Record<string, unknown>;

const INVALID_RESULT: ParseDapOperatorProvisioningResult = Object.freeze({
  ok: false,
  error: Object.freeze({ code: "INVALID_DAP_OPERATOR_PROVISIONING" as const }),
});

function invalid(): never {
  throw new Error("INVALID_DAP_OPERATOR_PROVISIONING");
}

function plainRecord(value: unknown): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as UnknownRecord;
  const prototype = Reflect.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Object.keys(record);
  if (keys.length > MAX_COLLECTION_ENTRIES) invalid();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor)) invalid();
  }
  return record;
}

function strictRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): UnknownRecord {
  const record = plainRecord(value);
  const keys = Object.keys(record);
  const allowed = new Set([...required, ...optional]);
  if (keys.some((key) => !allowed.has(key))) invalid();
  if (required.some((key) => !Object.hasOwn(record, key))) invalid();
  return record;
}

function field(record: UnknownRecord, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !("value" in descriptor)) invalid();
  return descriptor.value;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f))) return true;
  }
  return false;
}

function safeString(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_STRING_LENGTH ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    invalid();
  }
  return value;
}

function absoluteHostPath(value: unknown): string {
  const path = safeString(value);
  if (!isAbsolute(path)) invalid();
  return path;
}

function absoluteCapsulePath(value: unknown): string {
  const path = safeString(value);
  if (!posix.isAbsolute(path)) invalid();
  return path;
}

function uniqueStrings(
  value: unknown,
  parse: (item: unknown) => string,
  allowEmpty: boolean,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_COLLECTION_ENTRIES ||
    (!allowEmpty && value.length === 0)
  ) {
    invalid();
  }
  const values = value.map(parse);
  if (new Set(values).size !== values.length) invalid();
  return Object.freeze(values);
}

function executableName(value: unknown): string {
  const name = safeString(value);
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) invalid();
  return name;
}

function approvedPath(value: unknown): string {
  const path = safeString(value);
  const entries = path.split(delimiter);
  if (entries.some((entry) => !isAbsolute(entry)) || new Set(entries).size !== entries.length)
    invalid();
  return path;
}

function environmentName(value: unknown): string {
  const name = safeString(value);
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(name) || PROTECTED_ENVIRONMENT_NAMES.has(name)) invalid();
  return name;
}

function fixedEnvironment(value: unknown): Readonly<Record<string, string>> {
  const record = plainRecord(value);
  const entries = Object.keys(record)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => [environmentName(key), safeString(field(record, key))] as const);
  return Object.freeze(Object.fromEntries(entries));
}

function artifactCollection(value: unknown): readonly DapOperatorProvisionedArtifact[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COLLECTION_ENTRIES)
    invalid();
  const values = value.map(artifact);
  const identifiers = values.map((entry) => JSON.stringify(entry));
  if (new Set(identifiers).size !== identifiers.length) invalid();
  return Object.freeze(values);
}

function artifact(value: unknown): DapOperatorProvisionedArtifact {
  const record = strictRecord(value, ["hostPath", "approvedRoot", "capsulePath"]);
  const hostPath = absoluteHostPath(field(record, "hostPath"));
  const approvedRoot = absoluteHostPath(field(record, "approvedRoot"));
  if (hostPath === approvedRoot) invalid();
  return Object.freeze({
    hostPath,
    approvedRoot,
    capsulePath: absoluteCapsulePath(field(record, "capsulePath")),
  });
}

function npmConfig(value: unknown, expectedCapsulePath: string): DapOperatorProvisionedArtifact {
  const parsed = artifact(value);
  if (parsed.capsulePath !== expectedCapsulePath) invalid();
  return parsed;
}

function parseAdapter(value: unknown): Omit<DapOperatorAdapterProvisioning, "provisioningDigest"> {
  const record = strictRecord(
    value,
    ["executableName", "executableArgs", "trustedRoots", "approvedPath"],
    ["envAllowlist", "fixedEnv"],
  );
  return Object.freeze({
    executableName: executableName(field(record, "executableName")),
    executableArgs: uniqueStrings(field(record, "executableArgs"), safeString, true),
    trustedRoots: uniqueStrings(field(record, "trustedRoots"), absoluteHostPath, false),
    approvedPath: approvedPath(field(record, "approvedPath")),
    envAllowlist: Object.hasOwn(record, "envAllowlist")
      ? uniqueStrings(field(record, "envAllowlist"), environmentName, true)
      : Object.freeze([]),
    fixedEnv: Object.hasOwn(record, "fixedEnv")
      ? fixedEnvironment(field(record, "fixedEnv"))
      : Object.freeze({}),
  });
}

function parseLaunch(value: unknown): DapOperatorLaunchProvisioning {
  const record = strictRecord(
    value,
    [
      "adapterApprovedRoot",
      "node",
      "npm",
      "shell",
      "npmUserConfig",
      "npmGlobalConfig",
      "backend",
      "runtimeClosure",
    ],
    ["containerImage"],
  );
  const containerImage = Object.hasOwn(record, "containerImage")
    ? safeString(field(record, "containerImage"))
    : undefined;
  return Object.freeze({
    adapterApprovedRoot: absoluteHostPath(field(record, "adapterApprovedRoot")),
    node: artifact(field(record, "node")),
    npm: artifact(field(record, "npm")),
    shell: artifact(field(record, "shell")),
    npmUserConfig: npmConfig(field(record, "npmUserConfig"), NPM_USER_CONFIG_PATH),
    npmGlobalConfig: npmConfig(field(record, "npmGlobalConfig"), NPM_GLOBAL_CONFIG_PATH),
    backend: artifact(field(record, "backend")),
    runtimeClosure: artifactCollection(field(record, "runtimeClosure")),
    ...(containerImage === undefined ? {} : { containerImage }),
  });
}

function fingerprint(
  value: Omit<DapOperatorProvisioningDocument, "adapter"> & {
    readonly adapter: Omit<DapOperatorAdapterProvisioning, "provisioningDigest">;
  },
): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parse(value: unknown): DapOperatorProvisioningDocument {
  const record = strictRecord(value, ["schemaVersion", "adapter", "launch"]);
  if (field(record, "schemaVersion") !== 1) invalid();
  const adapter = parseAdapter(field(record, "adapter"));
  const launch = parseLaunch(field(record, "launch"));
  const provisioningDigest = fingerprint({ schemaVersion: 1, adapter, launch });
  return Object.freeze({
    schemaVersion: 1,
    adapter: Object.freeze({ ...adapter, provisioningDigest }),
    launch,
  });
}

/** Parses a trusted operator document without reading files, environment, or process state. */
export function parseDapOperatorProvisioningDocument(
  value: unknown,
): ParseDapOperatorProvisioningResult {
  try {
    return Object.freeze({ ok: true, value: parse(value) });
  } catch {
    return INVALID_RESULT;
  }
}
