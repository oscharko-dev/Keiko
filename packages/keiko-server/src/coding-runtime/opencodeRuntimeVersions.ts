/**
 * The one version boundary of the OpenCode integration (#3908). Every producer-derived identity a
 * runtime must present is pinned here, per approved upstream version: the release tag and commit,
 * the raw digest of its published protocol schema, and the structural digest of the admitted
 * protocol surface (`opencodeProtocolSurface.ts`). A routine upgrade adds the new version's pin,
 * regenerates the producer-derived fixtures and, once the npm runtime packages carrying it are
 * published, retires the previous entry. No other module restates a version-specific digest.
 */
export interface OpenCodeRuntimeVersionPin {
  readonly version: string;
  readonly tag: string;
  readonly commit: string;
  /** SHA-256 of the raw `packages/protocol/openapi.json` at `commit`. */
  readonly rawSchemaSha256: string;
  /** `keiko-opencode-protocol-surface-v2` digest of the admitted endpoints of that schema. */
  readonly protocolSurfaceSha256: string;
}

/** The version the portable release and the dev lane stage; the current pin. */
export const OPENCODE_PINNED_VERSION = "2.1.4";

/**
 * Current pin first. The second entry is the version the already published npm runtime packages
 * (`@oscharko-dev/keiko-coding-runtime-darwin-*` 1.1.3) carry; it stays admissible, with its own
 * digests, until packages built from the current pin are published and selected.
 */
export const OPENCODE_RUNTIME_VERSION_PINS: readonly OpenCodeRuntimeVersionPin[] = Object.freeze([
  Object.freeze({
    version: "2.1.4",
    tag: "v2.1.4",
    commit: "68bc26b7da1990ce10ffecfbc1e09eb13aa5d824",
    rawSchemaSha256: "4a01890f5810d71dca59ee39d9fb101c95f3bdf46332986a0bab0fa3885b68b9",
    protocolSurfaceSha256: "9432dd292cbfdb7c20b2f6ca52e00b135bd75f2fdd0ea6d017bad2b471ac9b0f",
  }),
  Object.freeze({
    version: "2.0.10",
    tag: "v2.0.10",
    commit: "b8cedc1a7a5e2916bbb65dc1d4b620729c261638",
    rawSchemaSha256: "1362671d8cfdcb925b3a9fd61eaa20152e4c587746445a0b03504674b25c88ec",
    protocolSurfaceSha256: "9a3f00a64c17a133158db7dbe9efd8906fb5ddb8cd768e20f1a3588cd0bc4b0a",
  }),
]);

export function openCodeRuntimeVersionPin(version: unknown): OpenCodeRuntimeVersionPin | undefined {
  if (typeof version !== "string") return undefined;
  return OPENCODE_RUNTIME_VERSION_PINS.find((pin) => pin.version === version);
}

export function isApprovedOpenCodeRuntimeVersion(version: unknown): version is string {
  return openCodeRuntimeVersionPin(version) !== undefined;
}
