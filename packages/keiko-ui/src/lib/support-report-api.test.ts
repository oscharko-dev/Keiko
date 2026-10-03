import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupportReport, downloadSupportReport } from "./support-report-api";
import { bffFetchJson } from "./http";

const response = vi.hoisted(() => ({ value: {} as unknown }));
vi.mock("./http", () => ({
  bffFetchJson: vi.fn(
    async (
      path: string,
      _init: RequestInit,
      options: { validator: (path: string, value: unknown) => unknown },
    ) => options.validator(path, response.value),
  ),
}));
afterEach(() => vi.restoreAllMocks());
const fileName = "keiko-support-v1-aabbccddeeff-2026-10-03.json";

describe("support report browser download", () => {
  it("accepts the closed canonical filename and preserves report bytes", async () => {
    response.value = { fileName, reportJson: '{"kind":"keiko.support.report"}' };
    expect(await createSupportReport("failure-1")).toEqual(response.value);
  });

  it("rejects a response with an unsafe filename or missing report", async () => {
    response.value = { fileName: "../../private.json", reportJson: "{}" };
    await expect(createSupportReport()).rejects.toThrow(TypeError);
    response.value = { fileName };
    await expect(createSupportReport()).rejects.toThrow(TypeError);
  });

  it("propagates cancellation through the bounded report request", async () => {
    response.value = { fileName, reportJson: "{}" };
    const controller = new AbortController();
    await createSupportReport("failure-cancelled", controller.signal);
    const signal = vi.mocked(bffFetchJson).mock.calls.at(-1)?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });

  it("starts a local download and releases its temporary object URL", () => {
    vi.useFakeTimers();
    const objectUrl = vi.fn(() => "blob:report");
    const revoke = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = objectUrl;
        static revokeObjectURL = revoke;
      },
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ): void {
      expect(this.download).toBe(fileName);
      expect(this.getAttribute("href")).toBe("blob:report");
      expect(document.body.contains(this)).toBe(true);
    });
    try {
      downloadSupportReport({ fileName, reportJson: "{}" });
      expect(click).toHaveBeenCalledOnce();
      expect(objectUrl).toHaveBeenCalledWith(expect.any(Blob));
      expect(document.querySelector("a[download]")).toBeNull();
      vi.runAllTimers();
      expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:report");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
