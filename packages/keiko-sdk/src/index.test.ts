import { describe, expect, it } from "vitest";

import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts";
import { SDK_VERSION } from "./index.js";

describe("SDK package surface", () => {
  it("keeps SDK_VERSION aligned with the product version contract", () => {
    expect(SDK_VERSION).toBe(KEIKO_PRODUCT_VERSION);
  });
});
