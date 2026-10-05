import { afterEach, describe, expect, it, vi } from "vitest";
import { loadLocaleMessages } from "./i18n";
import { setClientDiagnosticWriter, resetClientDiagnosticWriter } from "./client-diagnostics";
import {
  fetchGitDeliverySyncPreview,
  fetchGitDeliverySyncExecute,
  fetchGitDeliverySyncApprove,
  fetchGitHistory,
  fetchGitStatus,
  fetchGitSummary,
  fetchGitRemotes,
  fetchGitDiff,
  connectGitChangeToChat,
  refreshGitChangeScope,
} from "./api";

vi.mock("./coding-workbench-lazy-fetchers", () => {
  throw new TypeError("private chunk URL");
});
afterEach(() => {
  resetClientDiagnosticWriter();
  vi.unstubAllGlobals();
});
describe("git sync validator chunk failure", () => {
  it.each([fetchGitDeliverySyncPreview, fetchGitDeliverySyncExecute, fetchGitDeliverySyncApprove])(
    "logs the failed prerequisite before making any Git request",
    async (fetchSync) => {
      const writer = vi.fn();
      setClientDiagnosticWriter(writer);
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await expect(
        fetchSync({ operation: "fetch", projectId: "/private/repo" }),
      ).rejects.toBeDefined();
      expect(fetch).not.toHaveBeenCalled();
      expect(writer).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          moduleLoadFailure: "git-sync",
          errorEvidence: expect.objectContaining({ causeChain: ["TypeError"] }),
          correlationId: expect.any(String),
        }),
      );
      expect(JSON.stringify(writer.mock.calls)).not.toMatch(/private chunk URL|private\/repo/);
    },
  );
});

it("records history module failure with its own operation identity", async () => {
  const writer = vi.fn();
  setClientDiagnosticWriter(writer);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(fetchGitHistory({ root: "/private/repo" })).rejects.toBeDefined();
  expect(fetch).not.toHaveBeenCalled();
  expect(writer).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      moduleLoadFailure: "git-history",
      errorEvidence: expect.objectContaining({ causeChain: ["TypeError"] }),
    }),
  );
});

it.each([
  (): Promise<unknown> => fetchGitStatus("/private/repo"),
  (): Promise<unknown> => fetchGitSummary("/private/repo"),
  (): Promise<unknown> => fetchGitRemotes("/private/repo"),
  (): Promise<unknown> => fetchGitDiff({ root: "/private/repo", path: "private.ts" }),
])("refuses an ordinary Git read if its validator chunk cannot load", async (read) => {
  const writer = vi.fn();
  setClientDiagnosticWriter(writer);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const failure: unknown = await read().catch((error: unknown) => error);
  expect(failure).toMatchObject({
    code: "MODULE_LOAD_FAILED",
    correlationId: writer.mock.calls[0]?.[1].correlationId,
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(writer).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      moduleLoadFailure: "git-read",
      correlationId: expect.any(String),
      errorEvidence: expect.objectContaining({ causeChain: ["TypeError"] }),
    }),
  );
  expect(JSON.stringify(writer.mock.calls)).not.toMatch(
    /private chunk URL|private\/repo|private.ts/,
  );
});

it.each([
  (): Promise<unknown> =>
    connectGitChangeToChat(
      {
        chatId: "private-chat",
        mode: "comparison",
        baseRef: "private-base",
        headRef: "private-head",
      },
      undefined,
      "git-connect-attempt-123",
    ),
  (): Promise<unknown> =>
    refreshGitChangeScope(
      "private-chat",
      "private-relationship",
      undefined,
      "git-connect-attempt-123",
    ),
])("retains the Git mutation identity when its prerequisite chunk cannot load", async (mutate) => {
  const writer = vi.fn();
  setClientDiagnosticWriter(writer);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(mutate()).rejects.toMatchObject({
    code: "MODULE_LOAD_FAILED",
    correlationId: "git-connect-attempt-123",
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(writer).toHaveBeenCalledExactlyOnceWith(
    "git:module-load-failed",
    expect.objectContaining({
      moduleLoadFailure: "git-sync",
      correlationId: "git-connect-attempt-123",
      errorEvidence: expect.objectContaining({ causeChain: ["TypeError"] }),
    }),
  );
  expect(JSON.stringify(writer.mock.calls)).not.toMatch(/private/);
});

it.each([fetchGitStatus, fetchGitSummary])(
  "preserves the initiating ordinary read correlation through prerequisite failure",
  async (read) => {
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    await expect(
      read("/private/repo", { correlationId: "ui_read-attempt-123" }),
    ).rejects.toMatchObject({
      code: "MODULE_LOAD_FAILED",
      correlationId: "ui_read-attempt-123",
    });
    expect(writer).toHaveBeenCalledExactlyOnceWith(
      "git:module-load-failed",
      expect.objectContaining({
        moduleLoadFailure: "git-read",
        correlationId: "ui_read-attempt-123",
        errorKind: "unavailable",
      }),
    );
  },
);

it("localizes the Git prerequisite failure with the selected German catalog", async () => {
  setClientDiagnosticWriter(vi.fn());
  await loadLocaleMessages("de");
  window.localStorage.setItem("keiko.locale", "de");
  await expect(fetchGitStatus("/private/repo")).rejects.toMatchObject({
    message: "Git konnte nicht geladen werden. Lade Keiko neu und versuche es erneut.",
  });
});
