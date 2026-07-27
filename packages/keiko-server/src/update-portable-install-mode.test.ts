import { describe, expect, it } from "vitest";
import type { UpdatePortableInstallSummary } from "@oscharko-dev/keiko-contracts";
import { resolvePortableUnsupportedInstallKind } from "./update-portable-install-mode.js";

function portableSummary(
  overrides: Partial<UpdatePortableInstallSummary> = {},
): UpdatePortableInstallSummary {
  return {
    status: "managed",
    target: "macos-arm64",
    updateEligible: true,
    ...overrides,
  };
}

describe("resolvePortableUnsupportedInstallKind", () => {
  it("reports portable-setup-failed for a failed portable setup, regardless of summary status", () => {
    expect(
      resolvePortableUnsupportedInstallKind(
        "portable-setup-failed",
        portableSummary({ status: "setup-failed", updateEligible: false }),
      ),
    ).toBe("portable-setup-failed");
  });

  it("reports portable-managed for a non-stable release on an otherwise managed install", () => {
    expect(
      resolvePortableUnsupportedInstallKind(
        "portable-non-stable",
        portableSummary({ status: "managed", stable: false }),
      ),
    ).toBe("portable-managed");
  });

  it("falls back to portable-bootstrap for a non-stable release on a bootstrap install", () => {
    expect(
      resolvePortableUnsupportedInstallKind(
        "portable-non-stable",
        portableSummary({ status: "bootstrap", updateEligible: false, stable: false }),
      ),
    ).toBe("portable-bootstrap");
  });
});
