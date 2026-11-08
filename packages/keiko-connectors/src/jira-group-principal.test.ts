import { describe, expect, it, vi } from "vitest";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { bindJiraGroupPrincipal as bind } from "./jira-group-principal.js";

function request(body: Record<string, unknown>) {
  return vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: true, status: 200, body });
}
describe("supported exact native group principal binding", () => {
  it("uses supported groups/picker and binds exact presence within a partial fuzzy result", async () => {
    const send = request({
      groups: [{ name: "Other R&D team", html: "ignored" }, { name: "R&D team" }],
      total: 1000,
    });
    expect(await bind(send, "R&D team")).toBeUndefined();
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "groups/picker?query=R%26D+team&maxResults=100",
      "GET",
      undefined,
      "json",
    );
  });
  it.each([
    { groups: [], total: 0 },
    { groups: [{ name: "other R&D team" }], total: 1000 },
    { groups: [{ name: "r&d team" }], total: 1 },
  ])("keeps an unreturned exact name unavailable without inferring absence", async (body) => {
    const send = request(body);
    expect(await bind(send, "R&D team")).toMatchObject({ ok: false, reason: "unavailable" });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("explains a broad short name when the exact group falls outside a 100-row fuzzy prefix", async () => {
    const send = request({
      groups: Array.from({ length: 100 }, (_, index) => ({ name: `dev-team-${String(index)}` })),
      total: 101,
    });
    const result = await bind(send, "dev");
    expect(result).toMatchObject({
      ok: false,
      reason: "unavailable",
      detail: { messages: [expect.stringContaining("too broad")] },
    });
    expect(result?.detail?.messages?.[0]).toContain("at most 100");
    expect(result?.detail?.messages?.[0]).toContain("make this assignment in Jira");
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "groups/picker?query=dev&maxResults=100",
      "GET",
      undefined,
      "json",
    );
  });
  it.each([
    { groups: [{ name: "R&D team" }, { name: "R&D team" }], total: 2 },
    { groups: [{ name: "R&D team" }, {}], total: 2 },
    { groups: [{ name: "R&D team" }], total: 0 },
    { total: 0 },
    { groups: Array.from({ length: 101 }, (_, index) => ({ name: `group-${String(index)}` })) },
  ])(
    "rejects malformed or oversized observations instead of accepting a valid prefix",
    async (body) => {
      expect(await bind(request(body), "R&D team")).toMatchObject({
        ok: false,
        reason: "malformed-payload",
      });
    },
  );
  it.each([
    { ok: false, reason: "permission-denied", status: 403 },
    { ok: false, reason: "effect-denied" },
    { ok: false, reason: "cancelled" },
  ] as const)("preserves the original closed $reason refusal", async (failure) => {
    const send = vi.fn<JiraMutationRequest>().mockResolvedValue(failure);
    expect(await bind(send, "R&D team")).toMatchObject({ ok: false, reason: failure.reason });
  });
  it("retains a non-200 response as malformed and never sends a write", async () => {
    const outcome: AtlassianWriteHttpOutcome = { ok: true, status: 204, body: undefined };
    const send = vi.fn<JiraMutationRequest>().mockResolvedValue(outcome);
    expect(await bind(send, "R&D team")).toEqual({ ok: false, reason: "malformed-payload" });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
