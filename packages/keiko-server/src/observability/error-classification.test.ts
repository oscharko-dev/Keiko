// Direct unit coverage for the leaf module (ADR-0173 D11). `diagnostics-log.test.ts` already
// exercises `contentFreeErrorClass` extensively through the re-exported name, and this suite does
// not restate that coverage — it tests the primitives this module owns in their own right:
// `safeProperty`'s degrade-on-hostile-access contract and `machineToken`'s bounded-shape contract,
// both of which `server-log.ts`'s `errorKindOf` now depends on directly.
import { describe, expect, it } from "vitest";

import {
  contentFreeErrorClass,
  declaredErrorClassName,
  machineToken,
  safeProperty,
} from "./error-classification.js";

describe("safeProperty", () => {
  it("reads an own property off a plain object", () => {
    expect(safeProperty({ code: "X" }, "code")).toBe("X");
  });

  it("reads an inherited property off the prototype chain", () => {
    expect(safeProperty(new TypeError("x"), "name")).toBe("TypeError");
  });

  it("degrades to undefined for a non-object, non-function receiver", () => {
    expect(safeProperty("a string", "code")).toBeUndefined();
    expect(safeProperty(42, "code")).toBeUndefined();
    expect(safeProperty(null, "code")).toBeUndefined();
    expect(safeProperty(undefined, "code")).toBeUndefined();
  });

  it("degrades to undefined instead of throwing when the accessor itself throws", () => {
    const hostile: unknown = Object.defineProperty({}, "code", {
      get(): never {
        throw new Error("hostile accessor");
      },
    });
    expect(() => safeProperty(hostile, "code")).not.toThrow();
    expect(safeProperty(hostile, "code")).toBeUndefined();
  });

  it("degrades to undefined instead of throwing when the receiver is a trapping proxy", () => {
    const trap = new Proxy(
      {},
      {
        get(): never {
          throw new Error("hostile trap");
        },
      },
    );
    expect(() => safeProperty(trap, "code")).not.toThrow();
    expect(safeProperty(trap, "code")).toBeUndefined();
  });
});

describe("machineToken", () => {
  it("accepts an identifier-shaped code", () => {
    expect(machineToken("GATEWAY_TIMEOUT")).toBe("GATEWAY_TIMEOUT");
    expect(machineToken("ECONNREFUSED")).toBe("ECONNREFUSED");
  });

  it("rejects a prose-shaped value (spaces disqualify it)", () => {
    expect(machineToken("the request body was rejected")).toBeUndefined();
  });

  it("rejects a value over the 128-character bound", () => {
    expect(machineToken("A".repeat(129))).toBeUndefined();
    expect(machineToken("A".repeat(128))).toBe("A".repeat(128));
  });

  it("rejects a non-string value", () => {
    expect(machineToken(42)).toBeUndefined();
    expect(machineToken(undefined)).toBeUndefined();
    expect(machineToken(null)).toBeUndefined();
  });
});

describe("declaredErrorClassName", () => {
  it("degrades to undefined instead of throwing when getPrototypeOf traps", () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf(): never {
          throw new Error("trap");
        },
      },
    );
    expect(() => declaredErrorClassName(hostile as unknown as Error)).not.toThrow();
    expect(declaredErrorClassName(hostile as unknown as Error)).toBeUndefined();
  });
});

describe("contentFreeErrorClass", () => {
  it("still resolves to the generic Error class when getPrototypeOf traps", () => {
    // `instanceof` itself walks the prototype chain, so the trap fires before
    // `declaredErrorClassName` is ever reached; the outer try/catch here is what absorbs it.
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf(): never {
          throw new Error("trap");
        },
      },
    );
    expect(() => contentFreeErrorClass(hostile)).not.toThrow();
    expect(contentFreeErrorClass(hostile)).toBe("Error");
  });

  it("labels non-Error throws by their typeof", () => {
    expect(contentFreeErrorClass("plain string")).toBe("string");
    expect(contentFreeErrorClass(42)).toBe("number");
    expect(contentFreeErrorClass(null)).toBe("object");
    expect(contentFreeErrorClass(undefined)).toBe("undefined");
  });

  it("recovers a declared subclass name", () => {
    class GatewayShapedError extends Error {}
    expect(contentFreeErrorClass(new GatewayShapedError("x"))).toBe("GatewayShapedError");
  });

  it("lets a specific built-in name ride on a generic Error instance", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(contentFreeErrorClass(abort)).toBe("AbortError");
  });

  it("never surfaces a hostile-injected name", () => {
    const hostile = new Error("boom");
    hostile.name = "leaked request text";
    expect(contentFreeErrorClass(hostile)).toBe("Error");
  });
});
