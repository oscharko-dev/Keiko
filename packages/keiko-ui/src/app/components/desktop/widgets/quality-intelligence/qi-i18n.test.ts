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

describe("quality intelligence interpolation value observations", () => {
  it("reads shown before total exactly once", () => {
    const reads: string[] = [];
    const values = {
      get shown(): number {
        reads.push("shown");
        return 25;
      },
      get total(): number {
        reads.push("total");
        return 80;
      },
    };
    expect(translateQi("en", "qi.hub.truncated", values)).toBe("Showing 25 of 80 runs.");
    expect(reads).toEqual(["shown", "total"]);
  });

  it("retains a missing first token and still reads the later value", () => {
    const reads: string[] = [];
    const values = {
      get total(): number {
        reads.push("total");
        return 80;
      },
    };
    expect(translateQi("en", "qi.hub.truncated", values)).toBe("Showing {shown} of 80 runs.");
    expect(reads).toEqual(["total"]);
  });

  it("propagates the exact first getter error without observing total", () => {
    const failure = new TypeError("opaque interpolation inspection");
    const reads: string[] = [];
    const values = {
      get shown(): never {
        reads.push("shown");
        throw failure;
      },
      get total(): number {
        reads.push("total");
        return 80;
      },
    };
    let observed: unknown;
    try {
      translateQi("en", "qi.hub.truncated", values);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBe(failure);
    expect(reads).toEqual(["shown"]);
  });
});
