import { describe, expect, it } from "vitest";
import {
  validateHtmlManualPodCreateRequest,
  validateHtmlManualPodRefreshRequest,
} from "./html-manual-job.js";

describe("validateHtmlManualPodRefreshRequest", () => {
  it("accepts a well-formed refresh request", () => {
    const result = validateHtmlManualPodRefreshRequest({ capsuleId: "cap-1", sourceId: "src-1" });
    expect(result.ok).toBe(true);
  });

  it.each([false, true])("preserves original identity and bytes, frozen=%s", (frozen) => {
    const input = { capsuleId: "cap-1", sourceId: "src-1" };
    if (frozen) Object.freeze(input);
    const before = JSON.stringify(input);
    const result = validateHtmlManualPodRefreshRequest(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([undefined, null, 42, "", "a".repeat(129), "cap/1", "cap 1", "cap\n1"])(
    "rejects both unsafe ID fields independently: %s",
    (id) => {
      expect(validateHtmlManualPodRefreshRequest({ capsuleId: id, sourceId: "src-1" })).toEqual({
        ok: false,
        errors: ["capsuleId must be a safe id token"],
      });
      expect(validateHtmlManualPodRefreshRequest({ capsuleId: "cap-1", sourceId: id })).toEqual({
        ok: false,
        errors: ["sourceId must be a safe id token"],
      });
    },
  );

  it("accepts the existing 128-character bound and opaque ID grammar", () => {
    const input = { capsuleId: "a".repeat(128), sourceId: "a_.:-1" };
    expect(validateHtmlManualPodRefreshRequest(input)).toEqual({ ok: true, value: input });
  });

  it("retains first-extra-key and both missing-ID errors in order", () => {
    expect(validateHtmlManualPodRefreshRequest({ scope: "x", other: true })).toEqual({
      ok: false,
      errors: [
        "request must not include scope",
        "capsuleId must be a safe id token",
        "sourceId must be a safe id token",
      ],
    });
    expect(validateHtmlManualPodRefreshRequest({})).toEqual({
      ok: false,
      errors: ["capsuleId must be a safe id token", "sourceId must be a safe id token"],
    });
  });

  it("preserves enumeration and property-read order through the public validator", () => {
    const events: string[] = [];
    const input = new Proxy(
      { capsuleId: "cap-1", sourceId: "src-1" },
      {
        ownKeys(target): (string | symbol)[] {
          events.push("keys");
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, key): PropertyDescriptor | undefined {
          events.push(`descriptor:${String(key)}`);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        get(target, key, receiver): unknown {
          events.push(`get:${String(key)}`);
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const result = validateHtmlManualPodRefreshRequest(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(input);
    expect(events).toEqual([
      "keys",
      "descriptor:capsuleId",
      "descriptor:sourceId",
      "get:capsuleId",
      "get:sourceId",
    ]);
  });

  it("checks both malformed getter values once without short-circuiting", () => {
    const reads: string[] = [];
    const input = {
      get capsuleId(): number {
        reads.push("capsule");
        return 42;
      },
      get sourceId(): null {
        reads.push("source");
        return null;
      },
    };
    expect(validateHtmlManualPodRefreshRequest(input)).toEqual({
      ok: false,
      errors: ["capsuleId must be a safe id token", "sourceId must be a safe id token"],
    });
    expect(reads).toEqual(["capsule", "source"]);
  });

  it("preserves a throwing first getter without reading the second", () => {
    const reads: string[] = [];
    const failure = new TypeError("fixture-read");
    const input = {
      get capsuleId(): string {
        reads.push("capsule");
        throw failure;
      },
      get sourceId(): string {
        reads.push("source");
        return "src-1";
      },
    };
    let caught: unknown;
    try {
      validateHtmlManualPodRefreshRequest(input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(reads).toEqual(["capsule"]);
  });

  it.each([undefined, null, 42, "request", [], true])("rejects non-record input %s", (input) => {
    expect(validateHtmlManualPodRefreshRequest(input)).toEqual({
      ok: false,
      errors: ["request must be an object"],
    });
  });

  it("rejects non-objects, extra keys, and unsafe ids", () => {
    expect(validateHtmlManualPodRefreshRequest(null).ok).toBe(false);
    expect(
      validateHtmlManualPodRefreshRequest({ capsuleId: "cap-1", sourceId: "src-1", scope: "x" }).ok,
    ).toBe(false);
    expect(validateHtmlManualPodRefreshRequest({ capsuleId: "../etc", sourceId: "src-1" }).ok).toBe(
      false,
    );
    expect(validateHtmlManualPodRefreshRequest({ capsuleId: "cap-1", sourceId: "" }).ok).toBe(
      false,
    );
    expect(validateHtmlManualPodRefreshRequest({ capsuleId: "cap/1", sourceId: "src-1" }).ok).toBe(
      false,
    );
  });
});

describe("validateHtmlManualPodCreateRequest", () => {
  it("accepts a well-formed create request and normalises a missing pathPrefix to null", () => {
    const result = validateHtmlManualPodCreateRequest({
      displayName: "Ops Manual",
      origin: "https://manual.example.com",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.pathPrefix).toBeNull();
  });

  it("accepts an explicit safe path prefix", () => {
    const result = validateHtmlManualPodCreateRequest({
      displayName: "Ops Manual",
      origin: "https://manual.example.com",
      pathPrefix: "/docs/",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an unsafe origin, an empty name, extra keys, and a hostile path prefix", () => {
    expect(validateHtmlManualPodCreateRequest({ displayName: "x", origin: "ftp://x/y" }).ok).toBe(
      false,
    );
    expect(
      validateHtmlManualPodCreateRequest({ displayName: "", origin: "https://manual.example.com" })
        .ok,
    ).toBe(false);
    expect(
      validateHtmlManualPodCreateRequest({
        displayName: "x",
        origin: "https://manual.example.com",
        extra: 1,
      }).ok,
    ).toBe(false);
    expect(
      validateHtmlManualPodCreateRequest({
        displayName: "x",
        origin: "https://user:pass@manual.example.com",
      }).ok,
    ).toBe(false);
  });

  // KEIKO-0513: the 120-character bound is checked against the TRIMMED name, so returning the raw
  // string let padding carry an arbitrarily long value past a bound the contract documents as
  // enforced. The accepted value must be the same string the bound was checked against.
  it("returns the trimmed displayName so the bounded value is the persisted value", () => {
    const result = validateHtmlManualPodCreateRequest({
      displayName: `${" ".repeat(5_000)}abc`,
      origin: "https://manual.example.com",
      pathPrefix: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.displayName).toBe("abc");
  });

  it("rejects a displayName whose trimmed length still exceeds the bound", () => {
    expect(
      validateHtmlManualPodCreateRequest({
        displayName: "a".repeat(121),
        origin: "https://manual.example.com",
      }).ok,
    ).toBe(false);
  });
});
