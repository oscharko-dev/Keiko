/**
 * Parses an uploaded `keiko.config.json` into the gateway-setup form fields (owner-directed,
 * 0.3.0-beta.2): teams that already maintain a model-gateway configuration file load it instead of
 * retyping every field. The parser is fail-closed — any structural violation, connection-scalar
 * conflict, or provider kind this form cannot represent refuses the whole file rather than
 * applying a distorted half of it — and it runs entirely in the browser: the file is never
 * uploaded anywhere, and the parsed values flow into the exact same form state and validation
 * path as manual entry.
 */

export const MAX_GATEWAY_CONFIG_BYTES = 256 * 1024;

/** The provider kinds the generic deployment list can represent (contract: ModelKind). */
const REPRESENTABLE_KINDS = new Set(["chat", "embedding"]);
const KNOWN_KINDS = new Set(["chat", "embedding", "ocr-vision", "voice"]);

export interface GatewayConfigUploadFields {
  readonly baseUrl: string | undefined;
  readonly apiKey: string | undefined;
  readonly apiKeyHeaderName: string | undefined;
  readonly timeoutMs: string | undefined;
  readonly deploymentNames: readonly string[];
  /**
   * `undefined` when the file never speaks about the flag (no capability record anywhere); an
   * EMPTY list when it speaks and declares no model eligible — which must clear the form field
   * exactly like manually emptying it would.
   */
  readonly imageInputModelIds: readonly string[] | undefined;
  readonly workflowEligibleModelIds: readonly string[] | undefined;
  readonly figmaAccessToken: string | undefined;
}

export type GatewayConfigUploadResult =
  | { readonly outcome: "fields"; readonly fields: GatewayConfigUploadFields }
  | { readonly outcome: "invalid" }
  | { readonly outcome: "unsupportedKind" };

interface ParsedProvider {
  readonly modelId: string;
  readonly baseUrl: string | undefined;
  readonly apiKey: string | undefined;
  readonly apiKeyHeaderName: string | undefined;
  readonly timeoutMs: number | undefined;
  readonly capability: ParsedCapability | undefined;
}

interface ParsedCapability {
  readonly kind: string | undefined;
  readonly supportsImageInput: boolean;
  readonly workflowEligible: boolean;
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function optionalTimeout(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function parsedCapability(value: unknown): ParsedCapability | undefined {
  if (!objectRecord(value)) return undefined;
  return {
    kind: optionalString(value.kind),
    supportsImageInput: value.supportsImageInput === true,
    workflowEligible: value.workflowEligible === true,
  };
}

function parsedProvider(value: unknown): ParsedProvider | undefined {
  if (!objectRecord(value)) return undefined;
  const modelId = optionalString(value.modelId);
  if (modelId === undefined) return undefined;
  return {
    modelId,
    baseUrl: optionalString(value.baseUrl),
    apiKey: optionalString(value.apiKey),
    apiKeyHeaderName: optionalString(value.apiKeyHeaderName),
    timeoutMs: optionalTimeout(value.timeoutMs),
    capability: parsedCapability(value.capability),
  };
}

function parsedProviders(value: unknown): readonly ParsedProvider[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const providers: ParsedProvider[] = [];
  for (const entry of value) {
    const provider = parsedProvider(entry);
    // Fail closed on the whole file: silently dropping a malformed provider would present a
    // half-applied configuration as a fully loaded one.
    if (provider === undefined) return undefined;
    providers.push(provider);
  }
  return providers;
}

function parsedTopLevelCapabilities(
  value: unknown,
): ReadonlyMap<string, ParsedCapability> | undefined {
  const byId = new Map<string, ParsedCapability>();
  if (value === undefined) return byId;
  if (!Array.isArray(value)) return undefined;
  for (const entry of value) {
    // Same fail-closed policy as the provider list: a malformed capability record refuses the
    // whole file instead of being silently skipped (review finding on #3031).
    if (!objectRecord(entry)) return undefined;
    const id = optionalString(entry.id);
    const capability = parsedCapability(entry);
    if (id === undefined || capability === undefined) return undefined;
    byId.set(id, capability);
  }
  return byId;
}

/**
 * One connection per upload: the setup form holds a single base URL, token, header, and timeout,
 * so a file whose providers disagree on any of them cannot be represented — testing every model
 * against the first provider's connection would silently rewrite the others (review finding on
 * #3031).
 */
function consistentScalar<T>(values: readonly (T | undefined)[]): T | undefined | "conflict" {
  const defined = [...new Set(values.filter((value) => value !== undefined))];
  return defined.length > 1 ? "conflict" : defined[0];
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

/**
 * Top-level capability records are authoritative, mirroring the production configuration parser:
 * they override inline provider declarations for the same model id (review finding on #3031).
 */
function effectiveCapabilities(
  providers: readonly ParsedProvider[],
  topLevel: ReadonlyMap<string, ParsedCapability>,
): ReadonlyMap<string, ParsedCapability> | undefined {
  const byId = new Map<string, ParsedCapability>();
  const providerIds = new Set(providers.map((provider) => provider.modelId));
  for (const provider of providers) {
    if (provider.capability !== undefined) byId.set(provider.modelId, provider.capability);
  }
  for (const [id, capability] of topLevel) {
    // A capability for a model no provider imports would put an untestable id into the flag
    // lists and fail Test & Save AFTER a reported success (review finding on #3031).
    if (!providerIds.has(id)) return undefined;
    byId.set(id, capability);
  }
  return byId;
}

/**
 * Voice and OCR providers have dedicated setup fields this importer does not populate; putting
 * them into the generic deployment list would persist them with the wrong kind (review finding on
 * #3031). Unknown kind strings stay structurally invalid rather than silently generic.
 */
function unrepresentableKind(capabilities: ReadonlyMap<string, ParsedCapability>): boolean {
  return [...capabilities.values()].some(
    (capability) => capability.kind !== undefined && !REPRESENTABLE_KINDS.has(capability.kind),
  );
}

function knownKinds(capabilities: ReadonlyMap<string, ParsedCapability>): boolean {
  return [...capabilities.values()].every(
    (capability) => capability.kind === undefined || KNOWN_KINDS.has(capability.kind),
  );
}

function flaggedIds(
  capabilities: ReadonlyMap<string, ParsedCapability>,
  flag: "supportsImageInput" | "workflowEligible",
): readonly string[] {
  return unique(
    [...capabilities.entries()].filter(([, capability]) => capability[flag]).map(([id]) => id),
  );
}

function fieldsFrom(
  providers: readonly ParsedProvider[],
  capabilities: ReadonlyMap<string, ParsedCapability>,
  scalars: {
    readonly baseUrl: string | undefined;
    readonly apiKey: string | undefined;
    readonly apiKeyHeaderName: string | undefined;
    readonly timeoutMs: number | undefined;
    readonly figmaAccessToken: string | undefined;
  },
): GatewayConfigUploadFields {
  // A file with no capability record anywhere never speaks about the flags; a file with any
  // record speaks — and an empty result must clear the form field like manual emptying would
  // (review finding on #3031).
  const speaksAboutFlags = capabilities.size > 0;
  return {
    figmaAccessToken: scalars.figmaAccessToken,
    baseUrl: scalars.baseUrl,
    apiKey: scalars.apiKey,
    apiKeyHeaderName: scalars.apiKeyHeaderName,
    timeoutMs: scalars.timeoutMs === undefined ? undefined : String(scalars.timeoutMs),
    deploymentNames: unique(providers.map((provider) => provider.modelId)),
    imageInputModelIds: speaksAboutFlags
      ? flaggedIds(capabilities, "supportsImageInput")
      : undefined,
    workflowEligibleModelIds: speaksAboutFlags
      ? flaggedIds(capabilities, "workflowEligible")
      : undefined,
  };
}

function conflictFreeScalars(providers: readonly ParsedProvider[]):
  | {
      readonly baseUrl: string | undefined;
      readonly apiKey: string | undefined;
      readonly apiKeyHeaderName: string | undefined;
      readonly timeoutMs: number | undefined;
    }
  | undefined {
  const baseUrl = consistentScalar(providers.map((provider) => provider.baseUrl));
  const apiKey = consistentScalar(providers.map((provider) => provider.apiKey));
  const header = consistentScalar(providers.map((provider) => provider.apiKeyHeaderName));
  const timeout = consistentScalar(providers.map((provider) => provider.timeoutMs));
  if (
    baseUrl === "conflict" ||
    apiKey === "conflict" ||
    header === "conflict" ||
    timeout === "conflict"
  ) {
    return undefined;
  }
  return { baseUrl, apiKey, apiKeyHeaderName: header, timeoutMs: timeout };
}

export function parseGatewayConfigUpload(serialized: string): GatewayConfigUploadResult {
  let root: unknown;
  try {
    root = JSON.parse(serialized);
  } catch {
    return { outcome: "invalid" };
  }
  if (!objectRecord(root)) return { outcome: "invalid" };
  const providers = parsedProviders(root.providers);
  if (providers === undefined) return { outcome: "invalid" };
  const topLevel = parsedTopLevelCapabilities(root.capabilities);
  if (topLevel === undefined) return { outcome: "invalid" };
  const capabilities = effectiveCapabilities(providers, topLevel);
  if (capabilities === undefined) return { outcome: "invalid" };
  if (!knownKinds(capabilities)) return { outcome: "invalid" };
  if (unrepresentableKind(capabilities)) return { outcome: "unsupportedKind" };
  const scalars = conflictFreeScalars(providers);
  if (scalars === undefined) return { outcome: "invalid" };
  const figma = objectRecord(root.figma) ? optionalString(root.figma.accessToken) : undefined;
  return {
    outcome: "fields",
    fields: fieldsFrom(providers, capabilities, { ...scalars, figmaAccessToken: figma }),
  };
}

/** How many form fields an upload fills — the number the status line reports. */
export function appliedGatewayConfigFieldCount(fields: GatewayConfigUploadFields): number {
  const scalars = [
    fields.baseUrl,
    fields.apiKey,
    fields.apiKeyHeaderName,
    fields.timeoutMs,
    fields.figmaAccessToken,
  ];
  // A defined-but-empty flag list clears its field, which is an applied change too.
  const flagLists = [fields.imageInputModelIds, fields.workflowEligibleModelIds];
  return (
    scalars.filter((value) => value !== undefined).length +
    (fields.deploymentNames.length > 0 ? 1 : 0) +
    flagLists.filter((list) => list !== undefined).length
  );
}
