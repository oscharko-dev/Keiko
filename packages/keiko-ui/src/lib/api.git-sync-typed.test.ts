import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchGitDeliverySyncExecute,
  fetchGitDeliverySyncPreview,
  fetchGitDeliverySyncApprove,
  proposeGitDeliverySync,
  type GitDeliverySyncInput,
} from "./api";
import { responseCorrelationIdOf } from "./bff-correlation";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "./client-diagnostics";

afterEach(() => {
  resetClientDiagnosticWriter();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function syncFixture(phase: string): Record<string, unknown> {
  const common = { schemaVersion: "1", operation: "pull", available: true };
  if (phase === "execute") return { ...common, status: "succeeded", truncated: false };
  return {
    ...common,
    state: "available",
    detached: false,
    ahead: 0,
    behind: 0,
    hasRemote: true,
    hasUpstream: true,
    dirty: false,
    executable: true,
  };
}

function reply(value: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(value), {
    status,
    headers: { "X-Keiko-Correlation-Id": "git-sync-contract-test" },
  });
}

const syncRoutes = [
  { phase: "preview", send: fetchGitDeliverySyncPreview },
  { phase: "execute", send: fetchGitDeliverySyncExecute },
] as const;

describe("typed Git sync transport (#3918)", () => {
  for (const { phase, send } of syncRoutes) {
    it(`${phase}: preserves original response identity and exact authority-bearing POST`, async () => {
      const value = { ...syncFixture(phase), upstream: { ref: "origin/main" }, branch: undefined };
      const response = reply({});
      vi.spyOn(response, "json").mockResolvedValue(value);
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
      vi.stubGlobal("fetch", fetch);
      const diagnostic = vi.fn();
      setClientDiagnosticWriter(diagnostic);
      const input: GitDeliverySyncInput = {
        operation: "pull",
        projectId: "/private-sync-project",
        remote: "origin",
        approval: { schemaVersion: "1", approvalId: "gda_sync", approvalToken: "t".repeat(64) },
      };
      const controller = new AbortController();
      const result = await send(input, controller.signal);
      expect(result).toBe(value);
      expect(result.upstream).toBe(value.upstream);
      expect(Object.hasOwn(result, "branch")).toBe(true);
      expect(Object.hasOwn(result, "remote")).toBe(false);
      expect(responseCorrelationIdOf(result)).toBe("git-sync-contract-test");
      expect(fetch).toHaveBeenCalledTimes(1);
      const [path, options] = fetch.mock.calls[0] ?? [];
      expect(path).toBe(`/api/git-delivery/pull/${phase}`);
      expect(options).toMatchObject({
        method: "POST",
        body: JSON.stringify({
          schemaVersion: "1",
          projectId: input.projectId,
          remote: "origin",
          approval: input.approval,
        }),
        headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
      });
      controller.abort();
      expect(options?.signal?.aborted).toBe(true);
      expect(diagnostic).not.toHaveBeenCalled();
    });

    it(`${phase}: propagates cancellation without replay`, async () => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("cancelled", "AbortError")),
              { once: true },
            );
          }),
      );
      vi.stubGlobal("fetch", fetch);
      const controller = new AbortController();
      const pending = send(
        { operation: "fetch", projectId: "/private-sync-project" },
        controller.signal,
      );
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      controller.abort();
      await expect(pending).rejects.toBeDefined();
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it(`${phase}: preserves server authority refusal without retry or approval synthesis`, async () => {
      const fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: "AUTHORITY_DENIED", message: "Denied" } }), {
          status: 403,
        }),
      );
      vi.stubGlobal("fetch", fetch);
      await expect(
        send({ operation: "fetch", projectId: "/private-sync-project" }),
      ).rejects.toMatchObject({ code: "AUTHORITY_DENIED", status: 403 });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        `/api/git-delivery/fetch/${phase}`,
        expect.objectContaining({
          body: JSON.stringify({ schemaVersion: "1", projectId: "/private-sync-project" }),
        }),
      );
    });
    it.each([null, true, 1, "private-sync-response", []])(
      `${phase}: refuses primitive %j once with a correlated body-free diagnostic`,
      async (value) => {
        const diagnostic = vi.fn();
        setClientDiagnosticWriter(diagnostic);
        const fetch = vi.fn().mockResolvedValue(reply(value));
        vi.stubGlobal("fetch", fetch);
        await expect(
          send({ operation: "pull", projectId: "/private-sync-project" }),
        ).rejects.toMatchObject({
          code: "CONTRACT_VALIDATION_FAILED",
          status: 502,
          correlationId: "git-sync-contract-test",
        });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(diagnostic).toHaveBeenCalledTimes(1);
        expect(diagnostic).toHaveBeenCalledWith(
          "bff:contract-validation-failed",
          expect.objectContaining({
            errorKind: "validation-failed",
            correlationId: "git-sync-contract-test",
          }),
        );
        expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/private-sync|response must/);
      },
    );

    // Typed POST responses must not bypass admission on 204 or repeat a completed mutation.
    it(`${phase}: refuses an empty response without replaying its POST`, async () => {
      const diagnostic = vi.fn();
      setClientDiagnosticWriter(diagnostic);
      const fetch = vi.fn().mockResolvedValue(reply(undefined, 204));
      vi.stubGlobal("fetch", fetch);
      await expect(
        send({ operation: "pull", projectId: "/private-sync-project" }),
      ).rejects.toMatchObject({
        code: "CONTRACT_VALIDATION_FAILED",
        status: 502,
        correlationId: "git-sync-contract-test",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(diagnostic).toHaveBeenCalledTimes(1);
      expect(diagnostic).toHaveBeenCalledWith(
        "bff:contract-validation-failed",
        expect.objectContaining({ correlationId: "git-sync-contract-test" }),
      );
      expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/private-sync/);
    });
  }

  it("preserves explicit user initiation without adding an approval request", async () => {
    const fetch = vi.fn().mockResolvedValue(reply(syncFixture("execute")));
    vi.stubGlobal("fetch", fetch);
    await proposeGitDeliverySync({ operation: "pull", projectId: "/private-sync-project" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "/api/git-delivery/pull/execute",
      expect.objectContaining({
        body: JSON.stringify({
          schemaVersion: "1",
          projectId: "/private-sync-project",
          userInitiated: true,
        }),
      }),
    );
  });

  it("retains ordinary approval POST empty-response behavior", async () => {
    const fetch = vi.fn().mockResolvedValue(reply(undefined, 204));
    vi.stubGlobal("fetch", fetch);
    await expect(
      fetchGitDeliverySyncApprove({ operation: "pull", projectId: "/private-sync-project" }),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "/api/git-delivery/pull/approve",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it.each([
    null,
    true,
    1,
    "private-upstream",
    [],
    {},
    { ref: 1 },
    { ref: "origin/main", remote: "origin" },
  ])("execute: refuses malformed supplied upstream %j without replay", async (upstream) => {
    const diagnostic = vi.fn();
    setClientDiagnosticWriter(diagnostic);
    const fetch = vi.fn().mockResolvedValue(reply({ ...syncFixture("execute"), upstream }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      fetchGitDeliverySyncExecute({ operation: "pull", projectId: "/private-sync-project" }),
    ).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
      status: 502,
      correlationId: "git-sync-contract-test",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(
      /private-sync|private-upstream|origin/,
    );
  });
});
