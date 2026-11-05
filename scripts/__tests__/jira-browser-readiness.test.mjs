import { describe, expect, it, vi } from "vitest";
import {
  assertVerifiedPod,
  verifyPodAction,
} from "../testing/jira-chat-lab/browser-connections.mjs";

const IDENTITY = {
  authRef: "fixture-auth",
  livePod: { podId: "fixture-pod", authenticationGeneration: 2 },
};
const VERIFIED = {
  ...IDENTITY,
  livePod: { ...IDENTITY.livePod, verificationStatus: "ok", verificationRevision: 3 },
};

function fixtureCard() {
  const menu = { click: vi.fn() };
  const verify = { waitFor: vi.fn(), press: vi.fn() };
  return {
    menu,
    verify,
    getByRole: (role, options) => {
      if (role === "button" && options.name.test?.("More actions: Browser Jira")) return menu;
      if (role === "menuitem" && options.name === "Verify connection") return verify;
      throw new Error("Healthy Hub has no visible Verify button");
    },
    getByTestId: () => ({ count: async () => 0 }),
  };
}

describe("Jira browser qualification readiness", () => {
  it("observes the one automatic verification instead of issuing another request", async () => {
    const events = [];
    const response = {
      request: () => ({ method: () => "POST" }),
      url: () => "http://127.0.0.1/api/atlassian-connectors/credentials/fixture-auth/verify",
      status: () => 200,
      json: async () => ({ authRef: IDENTITY.authRef, status: "ok" }),
    };
    const page = {
      waitForResponse: (predicate) => {
        events.push("observe");
        expect(predicate(response)).toBe(true);
        expect(predicate({ ...response, request: () => ({ method: () => "GET" }) })).toBe(false);
        return Promise.resolve(response);
      },
    };
    await expect(verifyPodAction(page, () => events.push("create"))).resolves.toEqual({
      authRef: IDENTITY.authRef,
      status: "ok",
    });
    expect(events).toEqual(["observe", "create"]);
  });

  it("proves readiness from canonical metadata and the healthy card's actual menu", async () => {
    const page = {
      request: {
        get: vi.fn(async () => ({
          status: () => 200,
          json: async () => ({ credentials: [VERIFIED] }),
        })),
      },
    };
    const card = fixtureCard();
    await expect(assertVerifiedPod(page, card, IDENTITY)).resolves.toEqual(VERIFIED);
    expect(page.request.get).toHaveBeenCalledExactlyOnceWith(
      "/api/atlassian-connectors/credentials",
    );
    expect(card.menu.click).toHaveBeenCalledOnce();
    expect(card.verify.waitFor).toHaveBeenCalledOnce();
    expect(card.verify.press).toHaveBeenCalledExactlyOnceWith("Escape");
  });

  it.each([
    { ...VERIFIED, livePod: { ...VERIFIED.livePod, verificationStatus: "unverified" } },
    { ...VERIFIED, livePod: { ...VERIFIED.livePod, verificationRevision: 0 } },
    { ...VERIFIED, livePod: { ...VERIFIED.livePod, authenticationGeneration: 1 } },
    { ...VERIFIED, livePod: { ...VERIFIED.livePod, podId: "another-pod" } },
  ])("refuses unavailable or stale canonical verification (%j)", async (credential) => {
    const page = {
      request: {
        get: async () => ({ status: () => 200, json: async () => ({ credentials: [credential] }) }),
      },
    };
    await expect(assertVerifiedPod(page, fixtureCard(), IDENTITY)).rejects.toThrow();
  });
});
