import { describe, expect, it } from "vitest";
import { clientErrorClass as sourceClass } from "./diagnostics.js";
import { clientErrorClass as publicClass } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";

// Exercise the established APIs, so these same proofs can run before the internal extraction.
describe.each([
  { name: "source diagnostics", classify: sourceClass },
  { name: "public diagnostics", classify: publicClass },
])("closed error classification through $name", ({ classify }) => {
  it("returns only the single admitted name observation", () => {
    const error = new Error("private error message");
    error.stack = "";
    let reads = 0;
    Object.defineProperty(error, "name", {
      get(): string {
        reads += 1;
        return reads === 1 ? "TypeError" : "private-second-name-canary";
      },
    });
    expect(classify(error)).toBe("TypeError");
    expect(reads).toBe(1);
  });

  it("retains the ordinary closed error and native DOMException classes", () => {
    expect(classify(new Error("private"))).toBe("Error");
    expect(classify(new TypeError("private"))).toBe("TypeError");
    expect(classify(new DOMException("private", "AbortError"))).toBe("AbortError");
    expect(classify(new DOMException("private", "private-name"))).toBe("Error");
  });

  it("rejects an unreviewed error name after one observation", () => {
    const error = new Error("private");
    error.stack = "";
    let reads = 0;
    Object.defineProperty(error, "name", {
      get(): string {
        reads += 1;
        return "private-name";
      },
    });
    expect(classify(error)).toBe("Error");
    expect(reads).toBe(1);
  });

  it.each([
    [undefined, "undefined"],
    [null, "object"],
    [false, "boolean"],
    [1, "number"],
    [1n, "bigint"],
    ["private", "string"],
    [Symbol("private"), "symbol"],
    [(): void => undefined, "function"],
    [{ name: "TypeError" }, "object"],
  ])("retains typeof for non-Error value %#", (value, expected) => {
    expect(classify(value)).toBe(expected);
  });

  it("preserves the inspection exception for the existing suppression adapter", () => {
    const failure = new Error("private inspection failure");
    const error = new Error("private");
    error.stack = "";
    Object.defineProperty(error, "name", {
      get(): never {
        throw failure;
      },
    });
    expect(() => classify(error)).toThrow(failure);
  });

  it("preserves prototype inspection failure and revoked-proxy refusal", () => {
    const failure = new Error("private prototype failure");
    const error = new Proxy(
      {},
      {
        getPrototypeOf(): never {
          throw failure;
        },
      },
    );
    expect(() => classify(error)).toThrow(failure);
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => classify(revoked.proxy)).toThrow(TypeError);
  });
});
