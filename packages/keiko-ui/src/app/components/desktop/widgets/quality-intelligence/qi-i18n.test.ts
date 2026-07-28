import { describe, expect, it } from "vitest";

import { translateQi } from "./qi-i18n";

describe("quality intelligence translations", () => {
  it("interpolates every named value in run summaries", () => {
    expect(translateQi("en", "qi.hub.truncated", { shown: 25, total: 80 })).toBe(
      "Showing 25 of 80 runs.",
    );
    expect(translateQi("de", "qi.run.aria", { runId: "run-42" })).toBe(
      "Quality-Intelligence-Lauf run-42",
    );
  });
});
