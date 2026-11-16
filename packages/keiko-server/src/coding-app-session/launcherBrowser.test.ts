import { describe, expect, it, vi, type Mock } from "vitest";
import { decodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session-pairing";
import { createLauncherSessionPairingPort } from "./launcherSessionPairingPort.js";
import {
  createLauncherBrowser,
  nativeBrowserCommand,
  type LauncherBrowser,
  type LauncherBrowserTarget,
} from "./launcherBrowser.js";

const secret = "synthetic-launcher-browser-secret-with-32-characters";
function fixture(): {
  browser: LauncherBrowser;
  open: Mock<(target: LauncherBrowserTarget, url: string) => Promise<void>>;
  advance: () => void;
} {
  const open = vi
    .fn<(target: LauncherBrowserTarget, url: string) => Promise<void>>()
    .mockResolvedValue(undefined);
  let time = 0;
  const browser = createLauncherBrowser({ secret, port: 1983, open, now: () => time });
  return {
    browser,
    open,
    advance: (): void => {
      time += 10_000;
    },
  };
}

describe("launcher browser handoff", () => {
  it("delivers single-use proof only to the native opener, never the HTTP requester", async () => {
    const subject = fixture();
    expect(await subject.browser.open("firefox", "http://localhost:1983")).toBe("opened");
    const [target, url] = subject.open.mock.calls[0] ?? [];
    expect(target).toBe("firefox");
    const opened = new URL(String(url));
    expect(opened.origin).toBe("http://localhost:1983");
    const proof = decodeCodingAppSessionPairingFragment(opened.hash);
    if (proof === undefined) throw new TypeError("missing launcher proof");
    const authority = createLauncherSessionPairingPort({ secret });
    expect(authority.attest(proof).outcome).toBe("approved");
    expect(authority.attest(proof).outcome).toBe("denied");
  });

  it.each([
    "http://localhost:1984",
    "http://[::1]:1983",
    "https://localhost:1983",
    "http://evil.invalid:1983",
    "http://localhost:1983/redirect",
    "http://user@localhost:1983",
  ])("refuses an unowned destination %s before minting", async (origin) => {
    const subject = fixture();
    expect(await subject.browser.open("default", origin)).toBe("unavailable");
    expect(subject.open).not.toHaveBeenCalled();
  });

  it("bounds repeated and concurrent requests without extending the cooldown", async () => {
    const subject = fixture();
    expect(await subject.browser.open("default", "http://127.0.0.1:1983")).toBe("opened");
    expect(await subject.browser.open("default", "http://127.0.0.1:1983")).toBe("busy");
    subject.advance();
    expect(await subject.browser.open("default", "http://127.0.0.1:1983")).toBe("opened");
    expect(subject.open).toHaveBeenCalledTimes(2);
  });

  it("keeps native failure content out of its result", async () => {
    const subject = fixture();
    subject.open.mockRejectedValueOnce(new Error("PRIVATE_PROOF"));
    await expect(subject.browser.open("default", "http://localhost:1983")).rejects.toThrow(
      "Browser launcher failed",
    );
  });

  it("uses fixed application identifiers and argument arrays", () => {
    expect(nativeBrowserCommand("firefox", "http://localhost:1983/#synthetic", "darwin")).toEqual({
      command: "/usr/bin/open",
      args: ["-b", "org.mozilla.firefox", "http://localhost:1983/#synthetic"],
    });
    expect(nativeBrowserCommand("chrome", "http://localhost:1983", "linux")).toEqual({
      command: "google-chrome",
      args: ["http://localhost:1983"],
    });
    expect(nativeBrowserCommand("safari", "http://localhost:1983", "linux")).toBeUndefined();
  });
});
