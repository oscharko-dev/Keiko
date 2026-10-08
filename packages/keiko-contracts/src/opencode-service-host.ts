import { UPDATE_PORTABLE_TARGETS, type UpdatePortableTarget } from "./update-session.js";

/** Closed metadata only. Shape validation never approves, installs, selects, or launches a host. */
export const OPENCODE_SERVICE_HOST_FIXED_FACTS = Object.freeze({
  schemaVersion: 1,
  kind: "opencode-node-host",
  launchProfile: "fixed-node-bootstrap-v1",
  nodeVersion: "24.18.0",
  moduleVersion: "2.0.10",
  effectVersion: "4.0.0-rc.112",
  nodeExecutablePath: "runtime/node",
  bootstrapPath: "host.mjs",
  moduleIntegrity: "npm-sri",
  // npm SRI binds published bytes; it does not attest the source commit of their upstream build.
  sourceBuildProvenance: "reference-only",
  upstreamReferenceCommit: "b8cedc1a7a5e2916bbb65dc1d4b620729c261638",
  payloadTreeAlgorithm: "keiko-directory-tree-sha256-v1",
} as const);

export const OPENCODE_SERVICE_HOST_DIGEST_FIELDS = Object.freeze([
  "payloadTreeSha256",
  "archiveSha256",
  "nodeArchiveSha256",
  "nodeExecutableSha256",
  "bootstrapSha256",
  "packageLockSha256",
  "sbomSha256",
  "licenseInventorySha256",
  "buildProvenanceSha256",
  "builderSha256",
] as const);

const COUNT_LIMITS = Object.freeze({
  payloadFileCount: 60_000,
  payloadSizeBytes: 2 * 1024 * 1024 * 1024,
  archiveSizeBytes: 512 * 1024 * 1024,
});

export type OpenCodeServiceHostApproval = typeof OPENCODE_SERVICE_HOST_FIXED_FACTS & {
  readonly platformTarget: UpdatePortableTarget;
  readonly payloadFileCount: number;
  readonly payloadSizeBytes: number;
  readonly archiveSizeBytes: number;
} & Readonly<Record<(typeof OPENCODE_SERVICE_HOST_DIGEST_FIELDS)[number], string>>;

export type OpenCodeServiceHostApprovals = Readonly<
  Partial<Record<UpdatePortableTarget, OpenCodeServiceHostApproval>>
>;

const SHA256 = /^[a-f0-9]{64}$/u;
const TARGETS: ReadonlySet<unknown> = new Set(UPDATE_PORTABLE_TARGETS);
const FIELDS = new Set([
  ...Object.keys(OPENCODE_SERVICE_HOST_FIXED_FACTS),
  ...OPENCODE_SERVICE_HOST_DIGEST_FIELDS,
  ...Object.keys(COUNT_LIMITS),
  "platformTarget",
]);

/** An owned immutable copy; accessors, symbols, unknown fields, and false provenance fail closed. */
export function copyOpenCodeServiceHostApproval(
  value: unknown,
): OpenCodeServiceHostApproval | undefined {
  const record = dataRecord(value);
  return record !== undefined && isApproval(record) ? Object.freeze(record) : undefined;
}

/** Optional per-target supplemental approvals never replace the existing CLI archive approvals. */
export function copyOpenCodeServiceHostApprovals(
  value: unknown,
): OpenCodeServiceHostApprovals | undefined {
  const record = dataRecord(value);
  if (record === undefined || Object.keys(record).length === 0) return undefined;
  const result: Partial<Record<UpdatePortableTarget, OpenCodeServiceHostApproval>> = {};
  for (const [target, input] of Object.entries(record)) {
    const approval = copyOpenCodeServiceHostApproval(input);
    if (!TARGETS.has(target) || approval?.platformTarget !== target) return undefined;
    result[approval.platformTarget] = approval;
  }
  return Object.freeze(result);
}

function isApproval(
  record: Record<string, unknown>,
): record is Record<string, unknown> & OpenCodeServiceHostApproval {
  return (
    Object.keys(record).length === FIELDS.size &&
    Object.keys(record).every((key) => FIELDS.has(key)) &&
    TARGETS.has(record.platformTarget) &&
    Object.entries(OPENCODE_SERVICE_HOST_FIXED_FACTS).every(
      ([key, value]) => record[key] === value,
    ) &&
    OPENCODE_SERVICE_HOST_DIGEST_FIELDS.every(
      (key) => typeof record[key] === "string" && SHA256.test(record[key]),
    ) &&
    Object.entries(COUNT_LIMITS).every(([key, maximum]) => boundedCount(record[key], maximum))
  );
}

function boundedCount(value: unknown, maximum: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function dataRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length > FIELDS.size || keys.some((key) => typeof key !== "string")) return undefined;
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      Object.defineProperty(result, key, { value: descriptor.value, enumerable: true });
    }
    return result;
  } catch {
    return undefined;
  }
}
