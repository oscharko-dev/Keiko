import { describe, expect, it, vi } from "vitest";
import type { UiHandlerDeps } from "./deps.js";
import { fetchPortableGitHubReleaseAssets } from "./update-preflight-portable-assets.js";

describe("portable release metadata response ownership", () => {
  it("cancels a non-OK GitHub metadata body before returning unavailable", async () => {
    const response = new Response("not found", { status: 404 });
    const body = response.body;
    if (body === null) throw new Error("response fixture body is missing");
    const cancel = vi.spyOn(body, "cancel");
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(response));
    const deps = { env: {}, gatewayReadinessFetch: fetchImpl } as UiHandlerDeps;

    await expect(
      fetchPortableGitHubReleaseAssets(deps, "0.2.10", "windows-x64"),
    ).resolves.toMatchObject({ status: "unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
