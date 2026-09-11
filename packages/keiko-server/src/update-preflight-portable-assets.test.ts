import { describe, expect, it, vi } from "vitest";
import type { UiHandlerDeps } from "./deps.js";
import { buildRedactor, createInMemoryUiStore, createRunRegistry } from "./index.js";
import { fetchPortableGitHubReleaseAssets } from "./update-preflight-portable-assets.js";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";

function depsWith(fetchImpl: typeof fetch, overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    gatewayReadinessFetch: fetchImpl,
    ...overrides,
  };
}

describe("portable release metadata response ownership", () => {
  it("cancels a non-OK GitHub metadata body before returning unavailable", async () => {
    const response = new Response("not found", { status: 404 });
    const body = response.body;
    if (body === null) throw new Error("response fixture body is missing");
    const cancel = vi.spyOn(body, "cancel");
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(response));
    const deps = depsWith(fetchImpl);

    await expect(
      fetchPortableGitHubReleaseAssets(deps, "0.2.10", "windows-x64"),
    ).resolves.toMatchObject({ status: "unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledOnce();
    deps.store.close();
  });

  it("logs a body-free deadline reason when release metadata fetches time out", async () => {
    vi.useFakeTimers();
    const events: {
      readonly op: string;
      readonly extra?: Readonly<Record<string, unknown>> | undefined;
    }[] = [];
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.reject(new DOMException("sensitive timeout detail", "TimeoutError")),
    );
    const deps = depsWith(fetchImpl, {
      activityLog: {
        write: (event): void => {
          events.push(event);
        },
      },
    });

    try {
      const pending = fetchPortableGitHubReleaseAssets(deps, "0.2.10", "windows-x64");
      await vi.runAllTimersAsync();

      await expect(pending).resolves.toMatchObject({ status: "unavailable" });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(events).toContainEqual(
        expect.objectContaining({
          category: "diagnostic",
          correlationId: UNKNOWN_CORRELATION_ID,
          errorKind: "PORTABLE_FETCH_FAILURE",
          level: "warn",
          op: "update.portable-fetch.failed",
          extra: {
            assetKind: "release-metadata",
            reason: "deadline-exceeded",
            target: "windows-x64",
          },
        }),
      );
      expect(JSON.stringify(events)).not.toContain("sensitive timeout detail");
    } finally {
      vi.useRealTimers();
      deps.store.close();
    }
  });
});
