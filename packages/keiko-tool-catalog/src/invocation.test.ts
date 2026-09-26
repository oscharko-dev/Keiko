import { describe, expect, it, vi } from "vitest";
import type { ToolInvocationBinding } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import { createInitialToolCatalog } from "./legacy.js";
import { compileToolProjection } from "./projection.js";
import { createToolInvocationNormalizer } from "./invocation.js";
import { fixture } from "./__fixtures__/catalog.js";

const NOW = Date.parse("2026-09-05T00:00:00.000Z");
function binding(legacy = false): ToolInvocationBinding {
  const catalog = legacy ? createInitialToolCatalog() : fixture().catalog;
  const projection = compileToolProjection(catalog, {
    id: legacy ? "legacy-native" : "fixture",
    version: 1,
  });
  return {
    catalog,
    projection,
    offered: {
      binding: {
        catalogRevision: catalog.catalogRevision,
        profile: projection.profile,
        projectionDigest: projection.projectionDigest,
        handlerSetDigest: projection.projectionDigest,
        readiness: "ready",
      },
      offerId: "offer-1",
      toolRefs: projection.tools.map((tool) => tool.toolRef),
      expiresAt: new Date(NOW + 30_000).toISOString(),
    },
  };
}
function bound(input = binding()): object {
  return {
    kind: "bound",
    toolRef: input.projection.tools[0]?.toolRef,
    projectionDigest: input.projection.projectionDigest,
    offerId: input.offered.offerId,
    arguments: { path: "src/a.ts" },
  };
}

describe("catalog invocation bridge", () => {
  it("accepts only an offered subset when unavailable aggregate includes omitted handlers", () => {
    const input = binding(true);
    const tool = input.projection.tools.find((entry) => entry.alias === "read_file");
    if (tool === undefined) throw new TypeError("Missing read descriptor");
    const partial = {
      ...input,
      offered: {
        ...input.offered,
        binding: { ...input.offered.binding, readiness: "unavailable" as const },
        toolRefs: [tool.toolRef],
      },
    };
    expect(
      createToolInvocationNormalizer(partial)
        .tools(NOW)
        .map((entry) => entry.alias),
    ).toEqual(["read_file"]);
    expect(() =>
      createToolInvocationNormalizer(partial).bindAlias("run_command", { command: "npm" }, NOW),
    ).toThrow();
    expect(() =>
      createToolInvocationNormalizer({
        ...partial,
        offered: { ...partial.offered, toolRefs: input.offered.toolRefs },
      }),
    ).toThrow();
    for (const readiness of ["dry-run", "unsupported", "mismatch"] as const) {
      expect(() =>
        createToolInvocationNormalizer({
          ...partial,
          offered: { ...partial.offered, binding: { ...partial.offered.binding, readiness } },
        }),
      ).toThrow();
    }
  });
  it("normalizes the bound arm using the real descriptor producer", () => {
    const input = binding();
    const result = createToolInvocationNormalizer(input).normalize(bound(input), NOW);
    expect(result).toEqual(bound(input));
    expect(Object.isFrozen(result.arguments)).toBe(true);
  });
  it("captures immutable binding and arguments before a caller can mutate them", () => {
    const input = structuredClone(binding());
    const request = { ...bound(input), arguments: { path: "src/a.ts" } };
    const subject = createToolInvocationNormalizer(input);
    const result = subject.normalize(request, NOW);
    request.arguments.path = "changed";
    Object.assign(input.offered, { offerId: "changed" });
    expect(result.arguments).toEqual({ path: "src/a.ts" });
    expect(subject.normalize(bound(), NOW).offerId).toBe("offer-1");
  });
  it("maps only an offered provider alias to the same bound identity", () => {
    const subject = createToolInvocationNormalizer(binding());
    expect(subject.bindAlias("fixture_read", { path: "src/a.ts" }, NOW)).toEqual(
      subject.normalize(bound(), NOW),
    );
    expect(() => subject.bindAlias("read_file", {}, NOW)).toThrow();
  });
  it("rejects the removed name-only arm even with legacy session-shaped data", () => {
    const input = binding(true);
    const request = {
      kind: "legacy-name",
      name: "read_file",
      arguments: { path: "src/a.ts" },
      legacySession: { consumer: "native-harness" },
    };
    expect(() => createToolInvocationNormalizer(input).normalize(request, NOW)).toThrow();
  });
  it.each([
    { name: "fixture_read" },
    { legacySession: {} },
    { authority: "forged" },
    { kind: "legacy-name" },
    { projectionDigest: "a".repeat(64) },
    { offerId: "other" },
    { toolRef: { canonicalId: "keiko.fixture.read", contractVersion: 2 } },
    // #3415 AC3: implicit-latest resolution — omitting `contractVersion` must never fall back to
    // "whichever version is current" (also proven against the real producer by the matching
    // architecture negative fixture under tests/architecture/fixtures/, see
    // scripts/check-tool-catalog-conformance.mjs's CATALOG_SEMANTIC_NEGATIVE_FIXTURES).
    { toolRef: { canonicalId: "keiko.fixture.read" } },
    { toolRef: { canonicalId: "keiko.fixture.read", contractVersion: "latest" } },
    { arguments: { path: "src/a.ts", extra: true } },
    { arguments: null },
    { arguments: [] },
    { arguments: { path: 42 } },
    { arguments: { path: "a".repeat(65) } },
  ])("rejects ambiguous, stale or schema-invalid bound input %j", (override) => {
    expect(() =>
      createToolInvocationNormalizer(binding()).normalize({ ...bound(), ...override }, NOW),
    ).toThrow();
  });
  it("rejects getter/prototype/deep/wide arguments without reading getters", () => {
    const read = vi.fn(() => "src/a.ts");
    const getter = Object.defineProperty({}, "path", { enumerable: true, get: read });
    const inherited = Object.create({ path: "src/a.ts" }) as object;
    const nested = Array.from({ length: 20 }).reduce<object>((value) => ({ child: value }), {});
    const wide = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`k${String(index)}`, 1]),
    );
    for (const args of [getter, inherited, nested, wide]) {
      expect(() =>
        createToolInvocationNormalizer(binding()).normalize({ ...bound(), arguments: args }, NOW),
      ).toThrow();
    }
    expect(read).not.toHaveBeenCalled();
  });
  it("refuses an expired offer for both advertisement and invocation", () => {
    const subject = createToolInvocationNormalizer(binding());
    expect(() => subject.tools(NOW + 30_000)).toThrow();
    expect(() => subject.normalize(bound(), NOW + 30_000)).toThrow();
    expect(() => subject.tools(Number.NaN)).toThrow();
  });
  it("does not advertise non-productive readiness or let an unoffered call through", () => {
    const input = binding();
    const offered = {
      ...input.offered,
      binding: { ...input.offered.binding, readiness: "dry-run" as const },
      toolRefs: [],
    };
    const subject = createToolInvocationNormalizer({ ...input, offered });
    expect(subject.tools(NOW)).toEqual([]);
    expect(() => subject.normalize(bound(), NOW)).toThrow();
    expect(() =>
      createToolInvocationNormalizer({
        ...input,
        offered: { ...offered, toolRefs: input.offered.toolRefs },
      }),
    ).toThrow();
  });
  it("rejects exact digest fields over changed projection semantics", () => {
    const input = binding();
    const projection = {
      ...input.projection,
      tools: input.projection.tools.map((tool) => ({ ...tool, description: "changed semantics" })),
    };
    expect(() => createToolInvocationNormalizer({ ...input, projection })).toThrow();
  });
});
