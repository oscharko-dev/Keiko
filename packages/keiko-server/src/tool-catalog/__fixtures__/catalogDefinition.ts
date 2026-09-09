import type { ToolDescriptor } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  createToolRef,
  createToolDescriptor,
  createToolCatalog,
  compileToolProjection,
} from "@oscharko-dev/keiko-tool-catalog";
export function declaration(version = 1, openInput = false): object {
  return {
    toolRef: createToolRef("keiko.fixture.read", version),
    description: "Read bounded fixture data.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", minLength: 1, maxLength: 64 } },
      required: ["path"],
      additionalProperties: openInput,
    },
    resultSchema: {
      type: "object",
      properties: { text: { type: "string", maxLength: 64 } },
      required: ["text"],
      additionalProperties: false,
    },
    effects: ["workspace-read"],
    actionMapping: [{ action: "read", effects: ["workspace-read"] }],
    policyReferences: ["workspace-read-guards"],
    handlerRequirement: { id: "fixture-read", contractVersion: 1 },
    bounds: {
      maxArgumentBytes: 1024,
      maxResultBytes: 2048,
      maxResultCount: 1,
      maxDurationMs: 5000,
    },
    idempotency: "read-only",
    cancellation: "cooperative",
  };
}

export function profile(
  descriptor: ToolDescriptor,
  dialect = "gateway-json-schema",
  alias = "fixture_read",
): object {
  return {
    profile: { id: "fixture", version: 1 },
    toolRefs: [{ toolRef: descriptor.toolRef, alias }],
    nativeExtensions: [],
    adapterDialect: { id: dialect, version: 1 },
    adapterRuntime:
      dialect === "managed-runtime-json-schema"
        ? { id: "opencode", version: "1.17.17" }
        : { id: "keiko", version: "0.3.17" },
    compatibility: [],
  };
}

export function fixture(
  dialect = "gateway-json-schema",
  alias = "fixture_read",
): {
  readonly descriptor: ToolDescriptor;
  readonly catalog: ReturnType<typeof createToolCatalog>;
  readonly projection: ReturnType<typeof compileToolProjection>;
} {
  const descriptor = createToolDescriptor(
    declaration(1, dialect === "managed-runtime-json-schema"),
  );
  const catalog = createToolCatalog(
    {
      descriptors: [descriptor],
      profiles: [profile(descriptor, dialect, alias)],
      compatibility: [],
    },
    { referenceTimeMs: 0 },
  );
  return {
    descriptor,
    catalog,
    projection: compileToolProjection(catalog, { id: "fixture", version: 1 }),
  };
}
