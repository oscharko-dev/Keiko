import { describe, expect, it } from "vitest";

import { assertSafeDisplayField, assertSafeOptionalDisplayField } from "./display-validation.js";
import { KnowledgeStoreError } from "./errors.js";

// GEN-DUP-SEMANTIC-006: the "non-empty, trimmed, browser-safe display field" compound rule used to be
// re-inlined across four Local Knowledge write paths. These tests pin the single owner so a future
// edit to one write path cannot silently diverge the trust-boundary rule. A BELL (U+0007) is a
// control character rejected by the browser-safety predicate.
const BELL = String.fromCharCode(7);

describe("assertSafeDisplayField", () => {
  it("accepts a non-empty, trimmed, browser-safe value", () => {
    expect(() => {
      assertSafeDisplayField("displayName", "My Capsule");
    }).not.toThrow();
  });

  it("rejects an empty or whitespace-only value", () => {
    expect(() => {
      assertSafeDisplayField("displayName", "");
    }).toThrow(KnowledgeStoreError);
    expect(() => {
      assertSafeDisplayField("displayName", "   ");
    }).toThrow("displayName must be a browser-safe non-empty string");
  });

  it("rejects a value carrying control characters (not browser-safe)", () => {
    expect(() => {
      assertSafeDisplayField("tag", `bad${BELL}tag`);
    }).toThrow("tag must be a browser-safe non-empty string");
  });
});

describe("assertSafeOptionalDisplayField", () => {
  it("accepts undefined (the field is optional)", () => {
    expect(() => {
      assertSafeOptionalDisplayField("description", undefined);
    }).not.toThrow();
  });

  it("accepts a browser-safe present value", () => {
    expect(() => {
      assertSafeOptionalDisplayField("description", "A note");
    }).not.toThrow();
  });

  it("rejects a present but non-browser-safe value with the optional-field message", () => {
    expect(() => {
      assertSafeOptionalDisplayField("description", `note${BELL}`);
    }).toThrow("description must be browser-safe when set");
  });
});
