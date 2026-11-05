import { deepFreeze } from "./deep-freeze.js";
import pinData from "./opencode-runtime-pins.json" with { type: "json" };

/**
 * The one version source of the OpenCode integration. `opencode-runtime-pins.json` holds every
 * approved upstream version with its producer-derived identities; this module, the tool catalog,
 * the server and the release scripts all read it, so an upgrade changes one file.
 */
export interface OpenCodeRuntimeVersionPin {
  readonly version: string;
  readonly tag: string;
  readonly commit: string;
  /** SHA-256 of the raw protocol schema at `commit`. */
  readonly rawSchemaSha256: string;
  /** `keiko-opencode-protocol-surface-v2` digest of the admitted endpoints of that schema. */
  readonly protocolSurfaceSha256: string;
}

const [CURRENT_PIN] = pinData.pins;
if (CURRENT_PIN === undefined) {
  throw new TypeError("opencode-runtime-pins.json must name the current pin first");
}

/**
 * Current pin first. Each later entry is a version published npm runtime packages still carry; it
 * stays admissible, with its own digests, until packages built from the current pin are selected.
 */
export const OPENCODE_RUNTIME_VERSION_PINS: readonly OpenCodeRuntimeVersionPin[] = deepFreeze(
  pinData.pins,
);

/** The version the portable release and the dev lane stage; the current pin. */
export const OPENCODE_PINNED_VERSION: string = CURRENT_PIN.version;

/** The current pin's structural protocol digest. */
export const OPENCODE_PINNED_PROTOCOL_SURFACE_SHA256: string = CURRENT_PIN.protocolSurfaceSha256;

/** The adapter runtime the tool catalog's managed-runtime dialect binds. */
export const OPENCODE_CATALOG_RUNTIME = Object.freeze({
  id: "opencode",
  version: OPENCODE_PINNED_VERSION,
});

export function openCodeRuntimeVersionPin(version: unknown): OpenCodeRuntimeVersionPin | undefined {
  if (typeof version !== "string") return undefined;
  return OPENCODE_RUNTIME_VERSION_PINS.find((pin) => pin.version === version);
}

export function isApprovedOpenCodeRuntimeVersion(version: unknown): version is string {
  return openCodeRuntimeVersionPin(version) !== undefined;
}
