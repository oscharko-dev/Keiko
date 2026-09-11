import { describe, expect, it } from "vitest";
import { clientErrorSummary } from "./client-error-summary";

// Review on PR #3452: an error's name is text the error chose, so only the closed vocabulary the
// activity log admits survives; any other name travels as "Error".
describe("clientErrorSummary", () => {
  it("names a known class, a thrown non-Error by its type, and any other name as Error", () => {
    const hostile = new Error("x");
    hostile.name = "AliceSmithPassword";
    expect(clientErrorSummary(new TypeError("/Users/alice/.env could not be read"))).toBe(
      "TypeError",
    );
    expect(clientErrorSummary(hostile)).toBe("Error");
    expect(clientErrorSummary("token=sk-secret")).toBe("string");
    expect(clientErrorSummary(null)).toBe("object");
  });
});
