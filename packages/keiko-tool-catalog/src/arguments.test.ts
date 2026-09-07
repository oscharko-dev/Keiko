import { describe, expect, it } from "vitest";
import { validateToolArguments } from "./arguments.js";
import { createToolDescriptor } from "./descriptor.js";
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
