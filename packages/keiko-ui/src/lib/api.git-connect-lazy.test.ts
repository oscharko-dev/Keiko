import { afterEach, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => [] as string[]);
vi.mock("@oscharko-dev/keiko-contracts/bff-wire", async (original) => {
  const actual = await original<typeof import("@oscharko-dev/keiko-contracts/bff-wire")>();
  return {
    ...actual,
    get GIT_CHANGE_BLOCKED_REASONS(): typeof actual.GIT_CHANGE_BLOCKED_REASONS {
      reads.push("blocked");
      return actual.GIT_CHANGE_BLOCKED_REASONS;
    },
    get CHAT_GIT_CHANGE_DESCRIPTION_STATUSES(): typeof actual.CHAT_GIT_CHANGE_DESCRIPTION_STATUSES {
      reads.push("description");
      return actual.CHAT_GIT_CHANGE_DESCRIPTION_STATUSES;
    },
  };
});

afterEach(() => vi.unstubAllGlobals());

it("loads Git connect validators only when connecting a comparison", async () => {
  vi.resetModules();
  const api = await import("./api");
  expect(reads).toEqual([]);
  const fetch = vi.fn().mockRejectedValue(new TypeError("offline"));
  vi.stubGlobal("fetch", fetch);
  await expect(
    api.connectGitChangeToChat({
      chatId: "chat",
      mode: "comparison",
      baseRef: "main",
      headRef: "HEAD",
    }),
  ).rejects.toBeDefined();
  expect(reads.sort()).toEqual(["blocked", "description"]);
  expect(fetch).toHaveBeenCalledOnce();
});
