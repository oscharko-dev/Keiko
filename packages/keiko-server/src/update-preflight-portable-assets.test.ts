import { describe, expect, it, vi } from "vitest";
import type { UiHandlerDeps } from "./deps.js";
import { buildRedactor, createInMemoryUiStore, createRunRegistry } from "./index.js";
import { fetchPortableGitHubReleaseAssets } from "./update-preflight-portable-assets.js";

function depsWith(fetchImpl: typeof fetch): UiHandlerDeps {
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
});
