import { afterEach, expect, it, vi } from "vitest";

const imports = vi.hoisted(() => [] as string[]);
vi.mock("@oscharko-dev/keiko-contracts/runtime/git-repository-summary", async (original) => {
  imports.push("summary");
  return original();
});

afterEach(() => vi.unstubAllGlobals());

it("loads Git read validators only when a Git read is requested", async () => {
  vi.resetModules();
  const api = await import("./api");
  expect(imports).toEqual([]);
  const fetch = vi.fn().mockRejectedValue(new TypeError("offline"));
  vi.stubGlobal("fetch", fetch);
  await expect(api.fetchGitSummary("/repo")).rejects.toBeDefined();
  expect(imports.sort()).toEqual(["summary"]);
  expect(fetch).toHaveBeenCalledOnce();
});
