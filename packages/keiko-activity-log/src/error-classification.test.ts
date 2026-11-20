// Direct unit coverage for the leaf module (ADR-0173 D11). `diagnostics-log.test.ts` already
// exercises `contentFreeErrorClass` extensively through the re-exported name, and this suite does
// not restate that coverage — it tests the primitives this module owns in their own right:
// the typed field readers' degrade-on-hostile-access contract and `machineToken`'s bounded-shape
// contract, both of which `server-log.ts`'s `errorKindOf` now depends on directly.
import { describe, expect, it } from "vitest";

import {
  contentFreeErrorClass,
  declaredErrorClassName,
  errorArrayField,
  errorObjectField,
  errorStringField,
  machineToken,
  safeProperty,
  thrownErrorFields,
} from "./error-classification.js";

describe("safeProperty", () => {
  it("returns what the read returns", () => {
    expect(safeProperty(() => "X")).toBe("X");
  });

  it("degrades to undefined instead of throwing when the read throws", () => {
    const read = (): string => {
      throw new Error("hostile accessor");
    };
    expect(() => safeProperty(read)).not.toThrow();
    expect(safeProperty(read)).toBeUndefined();
  });
});

describe("thrown error field readers", () => {
  it("reads an own string field off a plain object", () => {
    expect(errorStringField(thrownErrorFields({ code: "X" }), "code")).toBe("X");
  });

  it("reads an inherited string field off the prototype chain", () => {
    expect(errorStringField(thrownErrorFields(new TypeError("x")), "name")).toBe("TypeError");
  });

  it("preserves machine metadata carried by a callable error value", () => {
    const callable = Object.assign(() => undefined, { code: "CALLABLE_FAILURE" });

    expect(errorStringField(thrownErrorFields(callable), "code")).toBe("CALLABLE_FAILURE");
  });

  it("admits no fields for a non-object, non-function value", () => {
    expect(thrownErrorFields("a string")).toBeUndefined();
    expect(thrownErrorFields(42)).toBeUndefined();
    expect(thrownErrorFields(null)).toBeUndefined();
    expect(thrownErrorFields(undefined)).toBeUndefined();
    expect(errorStringField(undefined, "code")).toBeUndefined();
  });

  it("returns a field only when it has the type the reader names", () => {
    const fields = thrownErrorFields({ code: 42, cause: "text", errors: "not-an-array" });
    expect(errorStringField(fields, "code")).toBeUndefined();
    expect(errorObjectField(fields, "cause")).toBeUndefined();
    expect(errorArrayField(fields, "errors")).toBeUndefined();
  });

  it("returns an object or callable field and an array field as they are", () => {
    const cause = { code: "ENOENT" };
    const callableCause = Object.assign(() => undefined, { code: "EACCES" });
    const errors = [cause, "primitive"];
    expect(errorObjectField(thrownErrorFields({ cause }), "cause")).toBe(cause);
    expect(errorObjectField(thrownErrorFields({ cause: callableCause }), "cause")).toBe(
      callableCause,
    );
    expect(errorArrayField(thrownErrorFields({ errors }), "errors")).toBe(errors);
  });

  it("degrades to undefined instead of throwing when the accessor itself throws", () => {
    const hostile: unknown = Object.defineProperty({}, "code", {
      get(): never {
        throw new Error("hostile accessor");
      },
    });
    expect(() => errorStringField(thrownErrorFields(hostile), "code")).not.toThrow();
    expect(errorStringField(thrownErrorFields(hostile), "code")).toBeUndefined();
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
    expect(() => errorObjectField(thrownErrorFields(trap), "cause")).not.toThrow();
    expect(errorObjectField(thrownErrorFields(trap), "cause")).toBeUndefined();
    expect(errorArrayField(thrownErrorFields(trap), "errors")).toBeUndefined();
  });
});

describe("machineToken", () => {
  it("accepts an identifier-shaped code", () => {
    expect(machineToken("GATEWAY_TIMEOUT")).toBe("GATEWAY_TIMEOUT");
    expect(machineToken("ECONNREFUSED")).toBe("ECONNREFUSED");
  });

  it("rejects a prose-shaped value (spaces disqualify it)", () => {
    expect(machineToken("the request body was rejected")).toBeUndefined();
    expect(machineToken("")).toBeUndefined();
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
  it("preserves a class exposed through a legitimate constructor accessor", () => {
    class AccessorConstructorError extends Error {}
    Object.defineProperty(AccessorConstructorError.prototype, "constructor", {
      configurable: true,
      get: () => AccessorConstructorError,
    });

    expect(declaredErrorClassName(new AccessorConstructorError("x"))).toBe(
      "AccessorConstructorError",
    );
  });

  it("preserves a bounded code-owned accessor class name", () => {
    class AccessorNameError extends Error {}
    Object.defineProperty(AccessorNameError, "name", {
      configurable: true,
      get: () => "DeclaredAccessorError",
    });

    expect(declaredErrorClassName(new AccessorNameError("x"))).toBe("DeclaredAccessorError");
  });

  it("preserves the inherited declaration across an intermediate prototype", () => {
    class ParentError extends Error {}
    class IntermediateError extends ParentError {}
    Reflect.deleteProperty(IntermediateError.prototype, "constructor");

    expect(declaredErrorClassName(new IntermediateError("x"))).toBe("ParentError");
  });

  it("preserves Node ERR_* constructor accessors", () => {
    let nodeError: unknown;
    try {
      Buffer.from(1 as unknown as string);
    } catch (error) {
      nodeError = error;
    }

    expect(nodeError).toBeInstanceOf(TypeError);
    expect(declaredErrorClassName(nodeError as Error)).toBe("TypeError");
  });

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
