import { afterEach, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

const imports = vi.hoisted(() => [] as string[]);
vi.mock("./api", async (original) => {
  imports.push("relationship-api");
  return original();
});

afterEach(() => vi.unstubAllGlobals());

it("loads the relationship API only for a successful Files binding and preserves its request", async () => {
  const { recordReadsContextRelationship } = await import("./connector-relationship");
  expect(imports).toEqual([]);
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ relationship: {}, etag: "1" })));
  vi.stubGlobal("fetch", fetch);
  recordReadsContextRelationship("", "/private/repo", "files-bind-123");
  recordReadsContextRelationship("private-chat", "", "files-bind-123");
  expect(imports).toEqual([]);
  expect(
    recordReadsContextRelationship("private-chat", "/private/repo", "files-bind-123"),
  ).toBeUndefined();
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(imports).toEqual(["relationship-api"]);
  expect(fetch).toHaveBeenCalledWith(
    "/api/relationships",
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        "Idempotency-Key": expect.stringMatching(/^rc-/u),
        "X-Keiko-CSRF": "1",
      }),
    }),
  );
  const init = fetch.mock.calls[0]?.[1] as RequestInit;
  expect(JSON.parse(String(init.body))).toMatchObject({
    proposal: {
      type: "reads-context",
      source: { kind: "chat", id: "private-chat" },
      target: { kind: "workspace-path", id: "/private/repo" },
    },
  });
});
