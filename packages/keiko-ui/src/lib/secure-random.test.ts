import { afterEach, describe, expect, it, vi } from "vitest";
import { secureRandomId, secureRandomInt } from "./secure-random";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("secure browser randomness", () => {
  it("uses randomUUID when the browser provides it", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: vi.fn(),
      randomUUID: vi.fn(() => "12345678-1234-4123-8123-123456789abc"),
    });
    expect(secureRandomId("request")).toBe("12345678-1234-4123-8123-123456789abc");
  });

  it("builds the legacy-browser fallback from getRandomValues without Math.random", () => {
    const random = vi.fn((values: Uint8Array): Uint8Array => {
      values.fill(0xab);
      return values;
    });
    vi.stubGlobal("crypto", { getRandomValues: random });
    expect(secureRandomId("request")).toBe(`request-${"ab".repeat(16)}`);
    expect(random).toHaveBeenCalledOnce();
  });

  it("rejects biased uint32 samples before returning a bounded integer", () => {
    const samples = [0xffff_ffff, 7];
    vi.stubGlobal("crypto", {
      getRandomValues: (values: Uint32Array): Uint32Array => {
        values[0] = samples.shift() ?? 0;
        return values;
      },
    });
    expect(secureRandomInt(10)).toBe(7);
    expect(samples).toEqual([]);
  });

  it("fails closed when secure browser randomness is unavailable", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => secureRandomId("request")).toThrow(TypeError);
  });

  it("fails closed when browser crypto lacks getRandomValues", () => {
    vi.stubGlobal("crypto", {});
    expect(() => secureRandomId("request")).toThrow(TypeError);
    expect(() => secureRandomInt(10)).toThrow(TypeError);
  });

  it.each([0, -1, 1.5, 0x1_0000_0001])("rejects invalid upper bound %s", (maximum) => {
    expect(() => secureRandomInt(maximum)).toThrow(RangeError);
  });
});
