/**
 * Parses an uploaded `keiko.config.json` into the gateway-setup form fields (owner-directed,
 * 0.3.0-beta.2): teams that already maintain a model-gateway configuration file load it instead of
 * retyping every field. The parser is fail-closed — any structural violation invalidates the whole
 * file rather than silently applying half of it — and it runs entirely in the browser: the file is
 * never uploaded anywhere, and the parsed values flow into the exact same form state and
 * validation path as manual entry.
 */

export const MAX_GATEWAY_CONFIG_BYTES = 256 * 1024;

export interface GatewayConfigUploadFields {
  readonly baseUrl: string | undefined;
  readonly apiKey: string | undefined;
  readonly apiKeyHeaderName: string | undefined;
  readonly timeoutMs: string | undefined;
  readonly deploymentNames: readonly string[];
  readonly imageInputModelIds: readonly string[];
  readonly workflowEligibleModelIds: readonly string[];
}

interface ParsedProvider {
  readonly modelId: string;
  readonly baseUrl: string | undefined;
  readonly apiKey: string | undefined;
  readonly apiKeyHeaderName: string | undefined;
  readonly timeoutMs: number | undefined;
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

function capabilityFlags(value: unknown): {
  readonly supportsImageInput: boolean;
  readonly workflowEligible: boolean;
} {
  if (!objectRecord(value)) return { supportsImageInput: false, workflowEligible: false };
  return {
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
    ...capabilityFlags(value.capability),
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

/** Standalone capability entries may widen the image/workflow model lists (same ids). */
function capabilityModelIds(
  value: unknown,
  flag: "supportsImageInput" | "workflowEligible",
): readonly string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const entry of value) {
    if (!objectRecord(entry)) continue;
    const id = optionalString(entry.id);
    if (id !== undefined && entry[flag] === true) ids.push(id);
  }
  return ids;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function firstDefined<T>(values: readonly (T | undefined)[]): T | undefined {
  return values.find((value) => value !== undefined);
}

export function parseGatewayConfigUpload(
  serialized: string,
): GatewayConfigUploadFields | undefined {
  let root: unknown;
  try {
    root = JSON.parse(serialized);
  } catch {
    return undefined;
  }
  if (!objectRecord(root)) return undefined;
  const providers = parsedProviders(root.providers);
  if (providers === undefined) return undefined;
  const timeout = firstDefined(providers.map((provider) => provider.timeoutMs));
  return {
    baseUrl: firstDefined(providers.map((provider) => provider.baseUrl)),
    apiKey: firstDefined(providers.map((provider) => provider.apiKey)),
    apiKeyHeaderName: firstDefined(providers.map((provider) => provider.apiKeyHeaderName)),
    timeoutMs: timeout === undefined ? undefined : String(timeout),
    deploymentNames: unique(providers.map((provider) => provider.modelId)),
    imageInputModelIds: unique([
      ...providers.filter((provider) => provider.supportsImageInput).map((p) => p.modelId),
      ...capabilityModelIds(root.capabilities, "supportsImageInput"),
    ]),
    workflowEligibleModelIds: unique([
      ...providers.filter((provider) => provider.workflowEligible).map((p) => p.modelId),
      ...capabilityModelIds(root.capabilities, "workflowEligible"),
    ]),
  };
}

/** How many form fields an upload fills — the number the status line reports. */
export function appliedGatewayConfigFieldCount(fields: GatewayConfigUploadFields): number {
  const scalars = [fields.baseUrl, fields.apiKey, fields.apiKeyHeaderName, fields.timeoutMs];
  const lists = [
    fields.deploymentNames,
    fields.imageInputModelIds,
    fields.workflowEligibleModelIds,
  ];
  return (
    scalars.filter((value) => value !== undefined).length +
    lists.filter((list) => list.length > 0).length
  );
}
