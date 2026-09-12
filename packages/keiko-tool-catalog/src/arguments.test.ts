import { describe, expect, it } from "vitest";
import { validateToolArguments } from "./arguments.js";
import { createToolDescriptor } from "./descriptor.js";
import { ToolCatalogError } from "./errors.js";
import { declaration, fixture } from "./__fixtures__/catalog.js";

describe("catalog invocation argument qualification", () => {
  it("returns a detached frozen value under the actual descriptor schema", () => {
    const { descriptor } = fixture();
    const input = { path: "file.ts" };
    const result = validateToolArguments(input, descriptor);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(Object.isFrozen(result)).toBe(true);
    input.path = "later.ts";
    expect(result).toEqual({ path: "file.ts" });
  });
  it.each([null, {}, { path: "" }, { path: 1 }, { path: "file.ts", root: "/private" }])(
    "rejects values outside the descriptor schema",
    (input) => {
      expect(() => validateToolArguments(input, fixture().descriptor)).toThrow("invalid-shape");
    },
  );
  // Run 7 of the Workbench engagement (2026-09-10): three identical `invalid-shape` rejections of
  // one call exhausted the gateway's retry budget, and neither the log nor the model's correction
  // could say which declared property was missing. The rejection now carries the schema's own account
  // -- declared property paths and a count -- and never the arguments.
  it.each([
    [
      {},
      {
        missingRequired: ["path"],
        invalidPaths: [],
        unexpectedPropertyCount: 0,
        droppedPathCount: 0,
      },
    ],
    [
      { path: 1 },
      {
        missingRequired: [],
        invalidPaths: ["path"],
        unexpectedPropertyCount: 0,
        droppedPathCount: 0,
      },
    ],
    [
      { path: "" },
      {
        missingRequired: [],
        invalidPaths: ["path"],
        unexpectedPropertyCount: 0,
        droppedPathCount: 0,
      },
    ],
    [
      { path: "file.ts", root: "/private" },
      { missingRequired: [], invalidPaths: [], unexpectedPropertyCount: 1, droppedPathCount: 0 },
    ],
  ] as const)(
    "names the schema mismatch on the rejection without quoting the value",
    (input, shape) => {
      const failure = ((): unknown => {
        try {
          validateToolArguments(input, fixture().descriptor);
          return undefined;
        } catch (error) {
          return error;
        }
      })();
      expect(failure).toBeInstanceOf(ToolCatalogError);
      expect(failure).toMatchObject({ reason: "invalid-shape", shape });
      expect(JSON.stringify((failure as ToolCatalogError).shape)).not.toContain("/private");
      expect(JSON.stringify((failure as ToolCatalogError).shape)).not.toContain("root");
    },
  );
  // PR #3452 review (CodeRabbit): every case above leaves `droppedPathCount` at 0, so the cap itself
  // was unpinned. A schema with more mismatching properties than the report cap must keep BOTH lists
  // bounded, count exactly what it left out, and still quote no argument value.
  it("bounds both mismatch lists at the cap and counts the paths it left out", () => {
    const width = 40;
    const properties = Object.fromEntries(
      Array.from({ length: width }, (_, index) => [
        `p${String(index).padStart(2, "0")}`,
        { type: "string", minLength: 1, maxLength: 8 },
      ]),
    );
    const descriptor = createToolDescriptor({
      ...declaration(),
      inputSchema: {
        type: "object",
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
      },
    });
    const secret = "SENTINEL_VALUE";
    // Half the declared properties are present but too long (invalid paths); half are absent
    // (missing required). Both lists overflow the cap of 16 by four entries each.
    const input = Object.fromEntries(
      Array.from({ length: width / 2 }, (_, index) => [
        `p${String(index).padStart(2, "0")}`,
        secret,
      ]),
    );

    const failure = ((): unknown => {
      try {
        validateToolArguments(input, descriptor);
        return undefined;
      } catch (error) {
        return error;
      }
    })();

    expect(failure).toBeInstanceOf(ToolCatalogError);
    const shape = (failure as ToolCatalogError).shape;
    expect(shape?.invalidPaths).toHaveLength(16);
    expect(shape?.missingRequired).toHaveLength(16);
    expect(shape?.droppedPathCount).toBe(width - 32);
    expect(shape?.unexpectedPropertyCount).toBe(0);
    expect(JSON.stringify(shape)).not.toContain(secret);
  });

  it("rejects untrusted descriptor identity and byte-bound violations", () => {
    const { descriptor } = fixture();
    expect(() =>
      validateToolArguments({ path: "file.ts" }, { ...descriptor, description: "tampered" }),
    ).toThrow();
    const bounded = createToolDescriptor({
      ...declaration(),
      bounds: { ...descriptor.bounds, maxArgumentBytes: 16 },
    });
    expect(() => validateToolArguments({ path: "bounded-file.ts" }, bounded)).toThrow(
      "input-bound",
    );
  });
  it("rejects getters and non-JSON data without executing them", () => {
    let reads = 0;
    const input = Object.defineProperty({}, "path", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "file.ts";
      },
    });
    expect(() => validateToolArguments(input, fixture().descriptor)).toThrow();
    expect(reads).toBe(0);
    expect(() =>
      validateToolArguments({ path: "file.ts", hidden: undefined }, fixture().descriptor),
    ).toThrow();
  });
});
