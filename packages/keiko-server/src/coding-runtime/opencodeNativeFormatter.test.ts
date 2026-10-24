import { describe, expect, it } from "vitest";
import { openCodeNativeEgress } from "./opencodeNativeEgress.js";
import {
  OPENCODE_NATIVE_FORMATTER_DISPOSITIONS,
  openCodeNativeFormatterDisposition,
  openCodeNativeFormatterSetting,
} from "./opencodeNativeFormatter.js";

const MODES = ["governed-assist", "supervised-coding", "autonomous-delivery"] as const;

describe("native built-in formatter disposition (parity row C07)", () => {
  it("enables the formatter in Full access only and names why it is off everywhere else", () => {
    expect(openCodeNativeFormatterDisposition("autonomous-delivery")).toBe("enabled");
    expect(openCodeNativeFormatterDisposition("supervised-coding")).toBe(
      "disabled-supervised-mode",
    );
    expect(openCodeNativeFormatterDisposition("governed-assist")).toBe("disabled-ask-mode");
  });

  it("fails closed for an absent or unrecognized mode", () => {
    for (const mode of [undefined, "", " autonomous-delivery", "AUTONOMOUS-DELIVERY", "full"])
      expect(openCodeNativeFormatterDisposition(mode)).toBe("disabled-unknown-mode");
  });

  it("turns the setting on for the one enabled disposition and off for every reason", () => {
    for (const disposition of OPENCODE_NATIVE_FORMATTER_DISPOSITIONS)
      expect(openCodeNativeFormatterSetting(disposition)).toBe(disposition === "enabled");
  });

  // The formatter is bound when the tree launches and cannot follow a resume that narrows the
  // mode. The composition refuses to narrow a tree whose kernel egress is inherited (a Full access
  // tree), and applies every other narrowing in place. A mode that enables the formatter must
  // therefore be one that can never be narrowed in place, or Ask for approval would inherit a
  // formatter it forbids. This pins the two rules together: widening either breaks the other here.
  it("enables the formatter only for a launch mode whose in-place narrowing is refused", () => {
    for (const mode of MODES)
      if (openCodeNativeFormatterDisposition(mode) === "enabled")
        expect(openCodeNativeEgress(mode)).toBe("inherited");
    expect(MODES.filter((mode) => openCodeNativeFormatterDisposition(mode) === "enabled")).toEqual([
      "autonomous-delivery",
    ]);
  });
});
