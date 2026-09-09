import { describe, expect, it } from "vitest";
import type { CatalogVersionRef } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  CATALOG_DIALECTS,
  compileToolProjection,
  createCatalogManifest,
  createToolCatalog,
  createToolDescriptor,
  createToolRef,
  gatewayToolDefinitions,
  lookupCatalogTool,
  validateToolResultEnvelope,
  verifyToolDescriptor,
} from "./index.js";
import { catalogBytes } from "./json.js";

import { declaration, profile, fixture } from "./__fixtures__/catalog.js";

describe("canonical descriptors and version axes", () => {
  it("creates exact branded references and rejects confusable or ambiguous identities", () => {
    expect(createToolRef("keiko.fixture.read", 1)).toEqual({
      canonicalId: "keiko.fixture.read",
      contractVersion: 1,
    });
    for (const id of [
      "keiko.read",
      "Keiko.fixture.read",
      "keiko.fixture.rеad",
      "keiko.fixture.read ",
    ])
      expect(() => createToolRef(id, 1)).toThrow();
    for (const version of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(() => createToolRef("keiko.fixture.read", version)).toThrow();
  });
  it("freezes a detached descriptor and every nested schema", () => {
    const input = declaration();
    const descriptor = createToolDescriptor(input);
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.inputSchema.properties)).toBe(true);
    expect(Object.isFrozen(descriptor.actionMapping[0])).toBe(true);
    expect(Reflect.set(input, "description", "changed after registration")).toBe(true);
    expect(descriptor.description).toBe("Read bounded fixture data.");
    expect(Reflect.set(descriptor.inputSchema, "type", "array")).toBe(false);
    expect(verifyToolDescriptor(descriptor)).toEqual(descriptor);
  });
  it("retains byte-identical descriptor and projection output across insertion order", () => {
    const input = declaration();
    const reversed = Object.fromEntries(Object.entries(input).reverse());
    expect(createToolDescriptor(reversed)).toEqual(createToolDescriptor(input));
    expect(JSON.stringify(createToolDescriptor(reversed))).toBe(
      JSON.stringify(createToolDescriptor(input)),
    );
  });
  it("validates the comparison descriptor before enforcing a version transition", () => {
    const previous = createToolDescriptor(declaration());
    expect(() =>
      createToolDescriptor(declaration(), {
        ...previous,
        description: "tampered comparison source",
      }),
    ).toThrow("invalid-identity");
  });
  it("rejects downgrade, same-version semantic mutation, and stale descriptor identity", () => {
    const prior = createToolDescriptor(declaration(2));
    expect(() => createToolDescriptor(declaration(1), prior)).toThrow("incompatible-version");
    expect(() =>
      createToolDescriptor({ ...declaration(2), description: "changed" }, prior),
    ).toThrow("incompatible-version");
    expect(createToolDescriptor(declaration(3), prior).toolRef.contractVersion).toBe(3);
    expect(() => verifyToolDescriptor({ ...prior, description: "tampered" })).toThrow(
      "invalid-identity",
    );
  });
  it.each([
    { bounds: undefined },
    { idempotency: "automatic-retry" },
    { cancellation: "ignore" },
    { effects: ["workspace-write"] },
    { effects: ["workspace-read", "workspace-read"] },
    { actionMapping: [{ action: "read", effects: ["workspace-write"] }] },
    { policyReferences: [] },
    { handlerRequirement: { id: "fixture-read", contractVersion: 1, ready: true } },
  ])("rejects missing, ambiguous, or authority-bearing metadata %j", (change) => {
    expect(() => createToolDescriptor({ ...declaration(), ...change })).toThrow();
  });
});

describe("profile compilation", () => {
  it("rejects a profile downgrade against the supplied producer checkpoint", () => {
    const descriptor = createToolDescriptor(declaration());
    const current = {
      descriptors: [descriptor],
      profiles: [profile(descriptor)],
      compatibility: [],
    };
    const previous = createToolCatalog(
      {
        ...current,
        profiles: [{ ...profile(descriptor), profile: { id: "fixture", version: 2 } }],
      },
      { referenceTimeMs: 0 },
    );
    expect(() => createToolCatalog(current, { referenceTimeMs: 0, previous })).toThrow(
      "incompatible-version",
    );
  });
  it("rejects republishing an unchanged profile version with a different alias-to-tool binding (b1-5)", () => {
    const readTool = createToolDescriptor(declaration());
    const otherTool = createToolDescriptor({
      ...declaration(),
      toolRef: createToolRef("keiko.fixture.other", 1),
    });
    const previous = createToolCatalog(
      { descriptors: [readTool], profiles: [profile(readTool)], compatibility: [] },
      { referenceTimeMs: 0 },
    );
    // Same profile id and version ("fixture"@1) as `previous`, but its one alias ("fixture_read")
    // now resolves to a different tool -- ADR-0175 D2 and #3406 require identical content once a
    // profile version is published.
    const rebound = { descriptors: [otherTool], profiles: [profile(otherTool)], compatibility: [] };
    expect(() => createToolCatalog(rebound, { referenceTimeMs: 0, previous })).toThrow(
      "incompatible-version",
    );
  });
  it.each(CATALOG_DIALECTS)("compiles one descriptor losslessly for %s", (dialect) => {
    const { descriptor, catalog, projection } = fixture(dialect);
    expect(projection.tools[0]?.inputSchema.properties).toEqual(descriptor.inputSchema.properties);
    expect(projection.tools[0]?.inputSchema.required).toEqual(descriptor.inputSchema.required);
    expect(projection.tools[0]?.inputSchema.additionalProperties).toBe(
      dialect === "managed-runtime-json-schema" ? undefined : false,
    );
    expect(projection.tools[0]?.resultSchema).toEqual(descriptor.resultSchema);
    expect(projection.tools[0]?.effects).toEqual(descriptor.effects);
    expect(
      new Set([descriptor.descriptorDigest, projection.projectionDigest, catalog.catalogRevision])
        .size,
    ).toBe(3);
    expect(Object.isFrozen(projection.tools)).toBe(true);
    expect(gatewayToolDefinitions(catalog, projection.profile)).toEqual([
      {
        name: "fixture_read",
        description: descriptor.description,
        parameters: projection.tools[0]?.inputSchema,
      },
    ]);
  });
  it("binds aliases to the profile projection without changing descriptor identity", () => {
    const first = fixture();
    const second = fixture("gateway-json-schema", "renamed_fixture_read");
    expect(first.descriptor.descriptorDigest).toBe(second.descriptor.descriptorDigest);
    expect(first.projection.projectionDigest).not.toBe(second.projection.projectionDigest);
    expect(first.catalog.catalogRevision).not.toBe(second.catalog.catalogRevision);
    expect(
      lookupCatalogTool(first.catalog, createToolRef("keiko.fixture.read", 2)),
    ).toBeUndefined();
  });
  it("does not accept duplicate descriptors, confusable aliases, or unknown runtime versions", () => {
    const descriptor = createToolDescriptor(declaration());
    const input = { descriptors: [descriptor], profiles: [profile(descriptor)], compatibility: [] };
    expect(() =>
      createToolCatalog(
        { ...input, descriptors: [descriptor, descriptor] },
        { referenceTimeMs: 0 },
      ),
    ).toThrow("duplicate-identity");
    expect(() => fixture("gateway-json-schema", "fіxture_read")).toThrow("invalid-identity");
    expect(() =>
      createToolCatalog(
        {
          ...input,
          profiles: [
            { ...profile(descriptor), adapterRuntime: { id: "keiko", version: "latest" } },
          ],
        },
        { referenceTimeMs: 0 },
      ),
    ).toThrow("invalid-identity");
    expect(() =>
      createToolCatalog(
        {
          ...input,
          profiles: [
            { ...profile(descriptor), adapterRuntime: { id: "keiko", version: "0.3.18" } },
          ],
        },
        { referenceTimeMs: 0 },
      ),
    ).toThrow("unsupported-dialect");
  });
  it("rejects a lossy OpenCode projection of optional custom arguments", () => {
    const descriptor = createToolDescriptor({
      ...declaration(),
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: [],
        additionalProperties: false,
      },
    });
    const catalog = createToolCatalog(
      {
        descriptors: [descriptor],
        profiles: [profile(descriptor, "managed-runtime-json-schema")],
        compatibility: [],
      },
      { referenceTimeMs: 0 },
    );
    expect(() => compileToolProjection(catalog, { id: "fixture", version: 1 })).toThrow(
      "unrepresentable-projection",
    );
  });
  it("generates a body-free manifest from the current producer", () => {
    const { catalog, projection, descriptor } = fixture();
    const manifest = createCatalogManifest(catalog, projection);
    expect(manifest.descriptorDigests).toEqual([descriptor.descriptorDigest]);
    const text = JSON.stringify(manifest);
    for (const body of [descriptor.description, "inputSchema", "resultSchema", "parameters"])
      expect(text).not.toContain(body);
    expect(() => compileToolProjection(catalog, { id: "unknown", version: 1 })).toThrow();
    expect(() =>
      compileToolProjection(catalog, {
        id: "fixture",
        version: "latest",
      } as unknown as CatalogVersionRef),
    ).toThrow();
  });
  it("rejects a forged catalog that retains an old revision after descriptor mutation", () => {
    const { catalog } = fixture();
    const changed = createToolDescriptor({ ...declaration(), description: "changed source" });
    expect(() =>
      compileToolProjection({ ...catalog, descriptors: [changed] }, { id: "fixture", version: 1 }),
    ).toThrow("invalid-identity");
  });
});

describe("bounded terminal envelopes", () => {
  it("validates completed data against the exact descriptor and projection", () => {
    const { descriptor, projection } = fixture();
    const data = { text: "bounded" };
    const result = {
      schemaVersion: 1,
      invocationId: "invocation-1",
      toolRef: descriptor.toolRef,
      projectionDigest: projection.projectionDigest,
      status: "completed",
      reason: "none",
      effectStarted: true,
      metrics: { inputBytes: 0, outputBytes: catalogBytes(data), resultCount: 1, durationMs: 2 },
      page: { truncated: false, reason: "none", cursor: null },
      data,
    };
    const binding = { descriptor, projectionDigest: projection.projectionDigest };
    expect(validateToolResultEnvelope(result, binding)).toEqual(result);
    expect(() =>
      validateToolResultEnvelope({ ...result, data: { text: "x".repeat(65) } }, binding),
    ).toThrow("result-contract-failed");
    expect(() =>
      validateToolResultEnvelope(
        { ...result, status: "failed", reason: "handler-failed" },
        binding,
      ),
    ).toThrow("result-contract-failed");
    expect(() =>
      validateToolResultEnvelope(
        { ...result, page: { truncated: false, reason: "none", cursor: "cursor-1" } },
        binding,
      ),
    ).toThrow("result-contract-failed");
  });
  it("represents pre-binding rejection without inventing a tool identity", () => {
    const result = {
      schemaVersion: 1,
      invocationId: "invocation-1",
      toolRef: null,
      projectionDigest: null,
      status: "invalid",
      reason: "unknown-tool",
      effectStarted: false,
      metrics: { inputBytes: 0, outputBytes: 0, resultCount: 0, durationMs: 0 },
      page: null,
      data: null,
    };
    expect(validateToolResultEnvelope(result)).toEqual(result);
    expect(() => validateToolResultEnvelope({ ...result, status: "denied" })).toThrow(
      "result-contract-failed",
    );
    expect(() => validateToolResultEnvelope({ ...result, effectStarted: true })).toThrow(
      "result-contract-failed",
    );
  });
});
