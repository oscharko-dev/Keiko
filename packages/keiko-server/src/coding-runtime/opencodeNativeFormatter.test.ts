import { describe, expect, it } from "vitest";
import { openCodeNativeEgress } from "./opencodeNativeEgress.js";
import {
  mergedFormatterSetting,
  OPENCODE_NATIVE_FORMATTER_DISPOSITIONS,
  openCodeNativeFormatterAdmission,
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

// #3900 AC4: in Full access the user's and the project's own `formatter` configuration select,
// override and add formatters as in standalone OpenCode, every entry re-validated.
describe("configured formatter entries (#3900 AC4)", () => {
  const custom = {
    formatter: {
      shfmt: { command: ["shfmt", "-w", "$FILE"], extensions: [".sh"], environment: { A: "1" } },
      gofmt: { disabled: true },
    },
  };

  it("carries the merged entries in Full access and true without configuration", () => {
    expect(openCodeNativeFormatterAdmission("enabled", [custom])).toEqual({
      value: custom.formatter,
      entryCount: 2,
      refusedCount: 0,
    });
    expect(openCodeNativeFormatterAdmission("enabled", [])).toEqual({
      value: true,
      entryCount: 0,
      refusedCount: 0,
    });
  });

  it("stays false in every other mode, whatever the documents configure", () => {
    for (const disposition of OPENCODE_NATIVE_FORMATTER_DISPOSITIONS.filter(
      (value) => value !== "enabled",
    ))
      expect(openCodeNativeFormatterAdmission(disposition, [custom]).value).toBe(false);
  });

  it("merges in the producer's order: a boolean replaces, an object merges entry and environment", () => {
    const merged = mergedFormatterSetting([
      { formatter: { shfmt: { command: ["shfmt", "$FILE"], environment: { A: "1" } } } },
      { formatter: { shfmt: { environment: { B: "2" } }, ruff: { disabled: true } } },
    ]);
    expect(merged.value).toEqual({
      shfmt: { command: ["shfmt", "$FILE"], environment: { A: "1", B: "2" } },
      ruff: { disabled: true },
    });
    expect(mergedFormatterSetting([custom, { formatter: false }]).value).toBe(false);
    expect(mergedFormatterSetting([{ formatter: false }, { formatter: {} }]).value).toEqual({});
  });

  it("refuses every key that could read the run's secrets, and malformed entries", () => {
    const merged = mergedFormatterSetting([
      {
        formatter: {
          leak: { command: ["sh", "-c", "echo {env:KEIKO_MODEL_GATEWAY_CAPABILITY}"] },
          file: { environment: { TOKEN: "{file:~/.ssh/id_rsa}" } },
          odd: { extensions: ["ts"], command: [], unknown: 1 },
          "bad name!": { disabled: true },
          plain: "not-an-object",
        },
      },
    ]);
    expect(merged.value).toEqual({ leak: {}, file: {}, odd: {} });
    expect(merged.refused).toBe(7);
  });
});
