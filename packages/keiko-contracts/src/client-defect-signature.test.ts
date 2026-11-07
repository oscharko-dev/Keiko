import { describe, expect, it } from "vitest";

import { clientDefectContext, isClientDefectContext } from "./client-defect-signature.js";

describe("client defect context", () => {
  it.each(["command-palette", "window-palette"])(
    "keeps the %s launcher stage in an incident identity (#4271)",
    (stage) => {
      const context = clientDefectContext({ clientKind: "boundary", stage });
      expect(context).toEqual(["kind:boundary", `stage:${stage}`]);
      expect(isClientDefectContext(context)).toBe(true);
    },
  );

  it("drops a stage outside the closed vocabulary", () => {
    expect(clientDefectContext({ clientKind: "boundary", stage: "window palette" })).toEqual([
      "kind:boundary",
    ]);
    expect(isClientDefectContext(["stage:unknown-launcher"])).toBe(false);
  });
});
