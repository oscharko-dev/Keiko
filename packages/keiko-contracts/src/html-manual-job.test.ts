import { describe, expect, it } from "vitest";
import { validateHtmlManualPodRefreshRequest } from "./html-manual-job.js";

describe("validateHtmlManualPodRefreshRequest", () => {
  it("accepts a well-formed refresh request", () => {
    const result = validateHtmlManualPodRefreshRequest({ capsuleId: "cap-1", sourceId: "src-1" });
    expect(result.ok).toBe(true);
  });

  it("rejects non-objects, extra keys, and unsafe ids", () => {
    expect(validateHtmlManualPodRefreshRequest(null).ok).toBe(false);
    expect(
      validateHtmlManualPodRefreshRequest({ capsuleId: "cap-1", sourceId: "src-1", scope: "x" }).ok,
    ).toBe(false);
    expect(validateHtmlManualPodRefreshRequest({ capsuleId: "../etc", sourceId: "src-1" }).ok).toBe(
      false,
    );
    expect(validateHtmlManualPodRefreshRequest({ capsuleId: "cap-1", sourceId: "" }).ok).toBe(
      false,
    );
    expect(validateHtmlManualPodRefreshRequest({ capsuleId: "cap/1", sourceId: "src-1" }).ok).toBe(
      false,
    );
  });
});
