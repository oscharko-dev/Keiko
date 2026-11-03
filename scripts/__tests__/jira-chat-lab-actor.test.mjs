import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareChat } from "../testing/jira-chat-lab/chat-read.mjs";

const origin = "http://127.0.0.1:1983";
const roots = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function actorSession() {
  const directory = mkdtempSync(join(tmpdir(), "keiko-jira-actor-"));
  roots.push(directory);
  mkdirSync(join(directory, "secrets"));
  for (const actor of ["api", "restricted", "editor", "assignee"])
    writeFileSync(join(directory, "secrets", `${actor}-token`), `fixture-pat-${actor}`, {
      mode: 0o600,
    });
  return { directory };
}
function pairedApi() {
  const chat = { id: "chat", groundingScopeIdentity: "scope", jiraPodBinding: { podId: "pod" } };
  const replies = [
    { authRef: "credential", livePod: { podId: "pod" } },
    { status: "ok" },
    { chat },
    { chat },
  ];
  const fetch = vi.fn(async () => new globalThis.Response(JSON.stringify(replies.shift())));
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  return fetch;
}

describe("live Chat seeded actor custody selection", () => {
  it.each([undefined, "restricted", "editor", "assignee"])(
    "materializes only the requested actor's private PAT: %s",
    async (actor) => {
      const fetch = pairedApi();
      await prepareChat(origin, "fixture-cookie", actorSession(), "project", "model", actor);
      expect(JSON.parse(fetch.mock.calls[0][1].body).apiToken).toBe(
        `fixture-pat-${actor ?? "api"}`,
      );
      expect(fetch).toHaveBeenCalledTimes(4);
    },
  );

  it.each(["admin", "../api", "other"])(
    "rejects an unseeded PAT actor before HTTP: %s",
    async (actor) => {
      const fetch = pairedApi();
      await expect(
        prepareChat(origin, "fixture-cookie", actorSession(), "project", "model", actor),
      ).rejects.toThrow(TypeError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
