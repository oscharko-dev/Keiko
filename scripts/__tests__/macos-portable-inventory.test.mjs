import { describe, expect, it } from "vitest";

import { hasUnsafeText } from "../macos-portable-inventory.mjs";

describe("hasUnsafeText", () => {
  it("rejects backslashes and C0/DEL control characters", () => {
    expect(hasUnsafeText("safe value")).toBe(false);
    expect(hasUnsafeText("bad\\path")).toBe(true);
    expect(hasUnsafeText("bad\npassword")).toBe(true);
    expect(hasUnsafeText(`bad${String.fromCharCode(127)}value`)).toBe(true);
  });

  it("treats a supplementary-plane character (surrogate pair) as safe, not control text", () => {
    // U+1F600 GRINNING FACE is encoded as a UTF-16 surrogate pair (2 code units). Read via
    // codePointAt it resolves to 0x1F600, far outside the checked control-character range, so it
    // must not be misclassified as unsafe the way a lone leading surrogate could be.
    expect(hasUnsafeText("Keiko \u{1F600} Bank")).toBe(false);
  });
});
