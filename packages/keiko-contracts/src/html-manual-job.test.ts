import { describe, expect, it } from "vitest";
import {
  validateHtmlManualPodCreateRequest,
  validateHtmlManualPodRefreshRequest,
} from "./html-manual-job.js";

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

describe("validateHtmlManualPodCreateRequest", () => {
  it("accepts a well-formed create request and normalises a missing pathPrefix to null", () => {
    const result = validateHtmlManualPodCreateRequest({
      displayName: "Ops Manual",
      origin: "https://manual.example.com",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.pathPrefix).toBeNull();
  });

  it("accepts an explicit safe path prefix", () => {
    const result = validateHtmlManualPodCreateRequest({
      displayName: "Ops Manual",
      origin: "https://manual.example.com",
      pathPrefix: "/docs/",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an unsafe origin, an empty name, extra keys, and a hostile path prefix", () => {
    expect(validateHtmlManualPodCreateRequest({ displayName: "x", origin: "ftp://x/y" }).ok).toBe(
      false,
    );
    expect(
      validateHtmlManualPodCreateRequest({ displayName: "", origin: "https://manual.example.com" })
        .ok,
    ).toBe(false);
    expect(
      validateHtmlManualPodCreateRequest({
        displayName: "x",
        origin: "https://manual.example.com",
        extra: 1,
      }).ok,
    ).toBe(false);
    expect(
      validateHtmlManualPodCreateRequest({
        displayName: "x",
        origin: "https://user:pass@manual.example.com",
      }).ok,
    ).toBe(false);
  });
});
