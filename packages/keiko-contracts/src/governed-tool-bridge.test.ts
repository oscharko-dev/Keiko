import { describe, expect, expectTypeOf, it } from "vitest";
import {
  boundGatewayToolCatalog,
  GATEWAY_NATIVE_EXACT_CONTENT_TOOLS,
  GATEWAY_NATIVE_TOOL_ADVERTISEMENT_LIMITS,
  gatewayNativeToolDefinitionBytes,
  gatewayNativeToolSchemaBytes,
  type GatewayNativeToolDefinition,
  isGatewayNativeToolAdvertisement,
} from "./governed-tool-bridge.js";
import type {
  GatewayNativeToolAdvertisement,
  GatewayToolCatalogAdvertisement,
  GovernedToolCallRequest,
} from "./governed-tool-bridge.js";
import type { BoundToolInvocation } from "./governed-tool-lifecycle.js";

const LIMITS = GATEWAY_NATIVE_TOOL_ADVERTISEMENT_LIMITS;
const DIGEST = "0123456789abcdef".repeat(4);

type Loose = Record<string, unknown>;

function nativeTool(name = "read", overrides: Loose = {}): Loose {
  return {
    name,
    description: "Read a file from the workspace.",
    parameters: { type: "object", properties: {} },
    ...overrides,
  };
}

function nativeAdvertisement(): GatewayNativeToolAdvertisement {
  return {
    kind: "native",
    runtime: { id: "opencode", version: "2.1.4" },
    tools: [{ name: "read", description: "Read a file.", parameters: { type: "object" } }],
    toolSetDigest: DIGEST,
    offered: { offerId: "offer-1", expiresAt: "2026-10-23T12:00:00.000Z" },
  };
}

/** A loose advertisement whose members are replaced by `overrides`, for hostile-shape cases. */
function advertisement(overrides: Loose = {}): Loose {
  return { ...nativeAdvertisement(), ...overrides };
}

/** A parameters object whose `JSON.stringify(...).length` is exactly `length`. */
function parametersOfLength(length: number): Loose {
  const parameters = { p: "x".repeat(length - JSON.stringify({ p: "" }).length) };
  expect(JSON.stringify(parameters)).toHaveLength(length);
  return parameters;
}

function toolsNamed(count: number): Loose[] {
  return Array.from({ length: count }, (_unused, index) => nativeTool(`tool_${String(index)}`));
}

function admits(value: unknown): boolean {
  return isGatewayNativeToolAdvertisement(value);
}

describe("governed tool bridge contract", () => {
  it("keeps the bound invocation arm owned by the lifecycle contract", () => {
    expectTypeOf<GovernedToolCallRequest["invocation"]>().toEqualTypeOf<BoundToolInvocation>();
    expectTypeOf<GatewayToolCatalogAdvertisement["kind"]>().toEqualTypeOf<"bound">();
  });
});

describe("native tool advertisement limits and exact-content tools (#3897, #4009)", () => {
  it("freezes the admission limits and keeps one maximal schema within the total budget", () => {
    expect(Object.isFrozen(LIMITS)).toBe(true);
    for (const limit of Object.values(LIMITS)) expect(Number.isSafeInteger(limit)).toBe(true);
    expect(LIMITS.maxSchemaBytes).toBeLessThanOrEqual(LIMITS.maxTotalBytes);
  });

  it("names the workspace-content and executable-source tools and cannot be altered", () => {
    expect([...GATEWAY_NATIVE_EXACT_CONTENT_TOOLS].sort()).toEqual([
      "edit",
      "execute",
      "patch",
      "shell",
      "write",
    ]);
    expect(Object.isFrozen(GATEWAY_NATIVE_EXACT_CONTENT_TOOLS)).toBe(true);
  });

  it("advertises every exact-content tool under a name the admission grammar accepts", () => {
    const tools = GATEWAY_NATIVE_EXACT_CONTENT_TOOLS.map((name) => nativeTool(name));
    expect(admits(advertisement({ tools }))).toBe(true);
  });
});

describe("isGatewayNativeToolAdvertisement", () => {
  it("admits a well-formed advertisement and narrows it to its typed shape", () => {
    const value: unknown = advertisement();
    expect(isGatewayNativeToolAdvertisement(value)).toBe(true);
    if (!isGatewayNativeToolAdvertisement(value)) throw new TypeError("expected a narrowing");
    expectTypeOf(value).toEqualTypeOf<GatewayNativeToolAdvertisement>();
    expect(value.tools.map((tool) => tool.name)).toEqual(["read"]);
    expect(value.runtime.version).toBe("2.1.4");
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "native"],
    ["a number", 42],
    ["an empty array", []],
    ["an array holding an advertisement", [advertisement()]],
  ])("rejects %s", (_label, value) => {
    expect(admits(value)).toBe(false);
  });

  it.each([
    ["a bound arm", "bound"],
    ["a differently cased kind", "Native"],
    ["a non-string kind", 1],
    ["an absent kind", undefined],
  ])("rejects %s as the kind", (_label, kind) => {
    expect(admits(advertisement({ kind }))).toBe(false);
  });

  it("rejects an unknown extra key", () => {
    expect(admits(advertisement({ extra: true }))).toBe(false);
  });

  it.each(["kind", "runtime", "tools", "toolSetDigest", "offered"])(
    "rejects an advertisement without %s",
    (key) => {
      const { [key]: _omitted, ...rest } = advertisement();
      expect(admits(rest)).toBe(false);
    },
  );

  it("rejects an advertisement that swaps a required key for another of the same count", () => {
    const { offered, ...rest } = advertisement();
    expect(Object.keys(rest)).toHaveLength(4);
    expect(admits({ ...rest, other: offered })).toBe(false);
  });

  it("does not count keys inherited from the prototype", () => {
    const inherited = Object.create(advertisement()) as Loose;
    expect(admits(inherited)).toBe(false);
  });
});

describe("native advertisement runtime identity", () => {
  it.each(["0.0.0", "2.1.4", "10.20.30"])("admits version %s", (version) => {
    expect(admits(advertisement({ runtime: { id: "opencode", version } }))).toBe(true);
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["a string", "opencode"],
    ["an array", ["opencode", "2.1.4"]],
    ["another runtime id", { id: "codex", version: "2.1.4" }],
    ["a differently cased id", { id: "OpenCode", version: "2.1.4" }],
    ["an absent id", { version: "2.1.4" }],
    ["an absent version", { id: "opencode" }],
    ["a numeric version", { id: "opencode", version: 2 }],
    ["a two-part version", { id: "opencode", version: "2.1" }],
    ["a four-part version", { id: "opencode", version: "2.1.4.1" }],
    ["a prerelease version", { id: "opencode", version: "2.1.4-beta.1" }],
    ["a v-prefixed version", { id: "opencode", version: "v2.1.4" }],
    ["a padded version", { id: "opencode", version: " 2.1.4" }],
    ["a version with a trailing newline", { id: "opencode", version: "2.1.4\n" }],
    ["an empty version", { id: "opencode", version: "" }],
  ])("rejects a runtime that is %s", (_label, runtime) => {
    expect(admits(advertisement({ runtime }))).toBe(false);
  });
});

describe("native advertisement tool-set digest", () => {
  it("admits a lowercase SHA-256 hex digest", () => {
    expect(admits(advertisement({ toolSetDigest: "f".repeat(64) }))).toBe(true);
  });

  it.each([
    ["absent", undefined],
    ["a number", 1],
    ["null", null],
    ["one character short", DIGEST.slice(1)],
    ["one character long", `${DIGEST}0`],
    ["upper case", DIGEST.toUpperCase()],
    ["not hexadecimal", "g".repeat(64)],
    ["padded with whitespace", ` ${DIGEST.slice(1)}`],
    ["followed by a newline", `${DIGEST}\n`],
    ["empty", ""],
  ])("rejects a digest that is %s", (_label, toolSetDigest) => {
    expect(admits(advertisement({ toolSetDigest }))).toBe(false);
  });
});

describe("native advertisement offer", () => {
  it("admits a one-character offer id and an ISO expiry", () => {
    expect(
      admits(advertisement({ offered: { offerId: "o", expiresAt: "2030-01-01T00:00:00Z" } })),
    ).toBe(true);
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["a string", "offer-1"],
    ["an array", ["offer-1", "2026-10-23T12:00:00.000Z"]],
    ["without an offer id", { expiresAt: "2026-10-23T12:00:00.000Z" }],
    ["with a numeric offer id", { offerId: 1, expiresAt: "2026-10-23T12:00:00.000Z" }],
    ["with an empty offer id", { offerId: "", expiresAt: "2026-10-23T12:00:00.000Z" }],
    ["without an expiry", { offerId: "offer-1" }],
    ["with a numeric expiry", { offerId: "offer-1", expiresAt: Date.parse("2026-10-23") }],
    ["with an empty expiry", { offerId: "offer-1", expiresAt: "" }],
    ["with an unparsable expiry", { offerId: "offer-1", expiresAt: "tomorrow" }],
  ])("rejects an offer that is %s", (_label, offered) => {
    expect(admits(advertisement({ offered }))).toBe(false);
  });
});

describe("native advertisement tool list", () => {
  it.each([
    ["absent", undefined],
    ["null", null],
    ["an object", { 0: nativeTool() }],
    ["a string", "read"],
    ["empty", []],
  ])("rejects a tool list that is %s", (_label, tools) => {
    expect(admits(advertisement({ tools }))).toBe(false);
  });

  it("admits exactly the maximum tool count and rejects one more", () => {
    expect(admits(advertisement({ tools: toolsNamed(LIMITS.maxTools) }))).toBe(true);
    expect(admits(advertisement({ tools: toolsNamed(LIMITS.maxTools + 1) }))).toBe(false);
  });

  it("rejects a repeated tool name anywhere in the list", () => {
    const tools = [nativeTool("read"), nativeTool("glob"), nativeTool("read")];
    expect(admits(advertisement({ tools }))).toBe(false);
  });

  it("rejects the whole list when one tool is invalid", () => {
    const tools = [nativeTool("read"), nativeTool("glob", { description: 7 })];
    expect(admits(advertisement({ tools }))).toBe(false);
  });

  // #3897 review: one byte contract counts every complete tool definition as UTF-8 JSON.
  it("admits complete definitions up to the total budget exactly and rejects one byte over it", () => {
    const { atBudget, overByOne } = budgetEdge();
    const sum = (tools: readonly GatewayNativeToolDefinition[]): number =>
      tools.reduce((total, tool) => total + gatewayNativeToolDefinitionBytes(tool), 0);
    expect(sum(atBudget)).toBe(LIMITS.maxTotalBytes);
    expect(sum(overByOne)).toBe(LIMITS.maxTotalBytes + 1);
    for (const tool of overByOne)
      expect(gatewayNativeToolSchemaBytes(tool.parameters)).toBeLessThanOrEqual(
        LIMITS.maxSchemaBytes,
      );
    expect(admits(advertisement({ tools: atBudget }))).toBe(true);
    expect(admits(advertisement({ tools: overByOne }))).toBe(false);
  });

  it("counts a schema in UTF-8 bytes, not UTF-16 code units", () => {
    const characters = Math.floor(LIMITS.maxSchemaBytes / 2);
    const parameters = { p: "\u00e9".repeat(characters) };
    expect(JSON.stringify(parameters).length).toBeLessThan(LIMITS.maxSchemaBytes);
    expect(gatewayNativeToolSchemaBytes(parameters)).toBeGreaterThan(LIMITS.maxSchemaBytes);
    expect(admits(advertisement({ tools: [{ name: "read", description: "", parameters }] }))).toBe(
      false,
    );
  });
});

describe("native advertisement tool definition", () => {
  it.each([
    ["null", null],
    ["a string", "read"],
    ["an array", ["read", "description", {}]],
    ["a number", 1],
  ])("rejects a tool that is %s", (_label, tool) => {
    expect(admits(advertisement({ tools: [tool] }))).toBe(false);
  });

  it("rejects a tool with an extra key", () => {
    expect(admits(advertisement({ tools: [nativeTool("read", { handler: "x" })] }))).toBe(false);
  });

  it.each(["name", "description", "parameters"])("rejects a tool without %s", (key) => {
    const { [key]: _omitted, ...rest } = nativeTool();
    expect(admits(advertisement({ tools: [rest] }))).toBe(false);
  });

  it("rejects a tool that swaps a required key for another of the same count", () => {
    const { parameters, ...rest } = nativeTool();
    expect(admits(advertisement({ tools: [{ ...rest, schema: parameters }] }))).toBe(false);
  });

  it.each([
    ["a bare word", "read"],
    ["mixed case", "ReadFile"],
    ["with digits, dots, dashes and underscores", "mcp.server-1_tool2"],
    ["a single letter", "a"],
  ])("admits a tool name that is %s", (_label, name) => {
    expect(admits(advertisement({ tools: [nativeTool(name)] }))).toBe(true);
  });

  it("admits a name at the maximum length and rejects one more character", () => {
    const atLimit = "a".repeat(LIMITS.maxToolNameChars);
    expect(admits(advertisement({ tools: [nativeTool(atLimit)] }))).toBe(true);
    expect(admits(advertisement({ tools: [nativeTool(`${atLimit}a`)] }))).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["a number", 7],
    ["null", null],
    ["starting with a digit", "1read"],
    ["starting with an underscore", "_read"],
    ["starting with a dot", ".read"],
    ["containing a space", "read file"],
    ["containing a slash", "mcp/read"],
    ["containing a colon", "mcp:read"],
    ["containing a non-ASCII letter", "réad"],
    ["ending in a newline", "read\n"],
  ])("rejects a tool name that is %s", (_label, name) => {
    expect(admits(advertisement({ tools: [nativeTool("read", { name })] }))).toBe(false);
  });

  it("admits a description at the maximum length and rejects one more character", () => {
    const atLimit = "d".repeat(LIMITS.maxDescriptionChars);
    expect(admits(advertisement({ tools: [nativeTool("read", { description: atLimit })] }))).toBe(
      true,
    );
    expect(
      admits(advertisement({ tools: [nativeTool("read", { description: `${atLimit}d` })] })),
    ).toBe(false);
  });

  it.each([
    ["a number", 1],
    ["null", null],
    ["an array of lines", ["Read a file."]],
  ])("rejects a description that is %s", (_label, description) => {
    expect(admits(advertisement({ tools: [nativeTool("read", { description })] }))).toBe(false);
  });

  it("admits an empty parameter schema object", () => {
    expect(admits(advertisement({ tools: [nativeTool("read", { parameters: {} })] }))).toBe(true);
  });

  it.each([
    ["null", null],
    ["an array", [{ type: "object" }]],
    ["a string", '{"type":"object"}'],
    ["a number", 1],
  ])("rejects parameters that are %s", (_label, parameters) => {
    expect(admits(advertisement({ tools: [nativeTool("read", { parameters })] }))).toBe(false);
  });

  it("admits a schema of exactly the per-tool byte limit and rejects one more", () => {
    const atLimit = nativeTool("read", { parameters: parametersOfLength(LIMITS.maxSchemaBytes) });
    const overByOne = nativeTool("read", {
      parameters: parametersOfLength(LIMITS.maxSchemaBytes + 1),
    });
    expect(admits(advertisement({ tools: [atLimit] }))).toBe(true);
    expect(admits(advertisement({ tools: [overByOne] }))).toBe(false);
  });
});

describe("boundGatewayToolCatalog", () => {
  // The projection inspects only the discriminant, so the bound arm needs no catalog fixture.
  const bound = { kind: "bound" } as unknown as GatewayToolCatalogAdvertisement;

  it("returns nothing when the request advertises no tools", () => {
    expect(boundGatewayToolCatalog(undefined)).toBeUndefined();
  });

  it("returns the very same catalog binding for a bound advertisement", () => {
    expect(boundGatewayToolCatalog(bound)).toBe(bound);
  });

  it("returns nothing for a native tool set, which is never a catalog binding", () => {
    expect(boundGatewayToolCatalog(nativeAdvertisement())).toBeUndefined();
  });
});

/** A native tool whose complete UTF-8 JSON definition is exactly `bytes` (production formula). */
function toolOfDefinitionBytes(name: string, bytes: number): GatewayNativeToolDefinition {
  const empty = gatewayNativeToolDefinitionBytes({ name, description: "", parameters: { p: "" } });
  return { name, description: "", parameters: { p: "x".repeat(bytes - empty) } };
}

/** Definitions that fill the total budget exactly, and the same set one byte over it. */
function budgetEdge(): {
  readonly atBudget: GatewayNativeToolDefinition[];
  readonly overByOne: GatewayNativeToolDefinition[];
} {
  const { maxSchemaBytes, maxTotalBytes } = GATEWAY_NATIVE_TOOL_ADVERTISEMENT_LIMITS;
  const count = maxTotalBytes / maxSchemaBytes;
  const atBudget = Array.from({ length: count }, (_unused, index) =>
    toolOfDefinitionBytes(`full_${String(index)}`, maxSchemaBytes),
  );
  const last = `full_${String(count - 1)}`;
  return {
    atBudget,
    overByOne: [...atBudget.slice(0, -1), toolOfDefinitionBytes(last, maxSchemaBytes + 1)],
  };
}

describe("the native tool name actually consumed for duplicate admission", () => {
  it.each([undefined, 42, "", "not a tool name"])(
    "refuses an invalid second name observation: %s",
    (second): void => {
      let reads = 0;
      const receivers: unknown[] = [];
      const tool = nativeTool();
      Object.defineProperty(tool, "name", {
        get: function (this: unknown): unknown {
          reads += 1;
          receivers.push(this);
          return reads === 1 ? "read" : second;
        },
      });
      const admitted = admits(advertisement({ tools: [tool] }));
      expect(admitted).toBe(false);
      expect(reads).toBe(2);
      expect(receivers).toHaveLength(2);
      for (const receiver of receivers) expect(receiver).toBe(tool);
    },
  );

  it.each(["read", "write"])(
    "admits a valid second name without imposing capture equality: %s",
    (second): void => {
      let reads = 0;
      const tool = nativeTool();
      Object.defineProperty(tool, "name", {
        get: (): string => {
          reads += 1;
          return reads === 1 ? "read" : second;
        },
      });
      expect(admits(advertisement({ tools: [tool] }))).toBe(true);
      expect(reads).toBe(2);
    },
  );

  it("preserves a thrown second name observation by identity", (): void => {
    const failure: TypeError = Object.freeze(new TypeError("second tool name failed"));
    let reads = 0;
    const tool = nativeTool();
    Object.defineProperty(tool, "name", {
      get: (): string => {
        reads += 1;
        if (reads === 2) throw failure;
        return "read";
      },
    });
    let caught: unknown;
    try {
      admits(advertisement({ tools: [tool] }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(reads).toBe(2);
  });
});
