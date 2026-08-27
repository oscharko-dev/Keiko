import { describe, expect, it } from "vitest";

import * as contractsRoot from "./index.js";
import { KEIKO_CONTRACTS_VERSION } from "./version.js";

describe("contracts runtime surface", () => {
  it("keeps the root barrel type-only while runtime values remain available from their domain module", () => {
    expect(Object.keys(contractsRoot)).toEqual([]);
    expect(KEIKO_CONTRACTS_VERSION).toBe("0.3.17");
  });
});
