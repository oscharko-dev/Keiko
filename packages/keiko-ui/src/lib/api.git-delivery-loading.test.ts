import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitDeliveryStageInput } from "./api";
import type { ClientDiagnosticWriter } from "./client-diagnostics";

function deferredImport(): { readonly ready: Promise<void>; release: () => void } {
  let complete: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return {
    ready,
    release: (): void => {
      if (complete === undefined) throw new TypeError("Missing import release");
      complete();
    },
  };
}

function holdGitDeliveryImport(): ReturnType<typeof deferredImport> {
  const gate = deferredImport();
  vi.doMock("./coding-workbench-lazy-fetchers", async () => {
    await gate.ready;
    return vi.importActual<typeof import("./coding-workbench-lazy-fetchers")>(
      "./coding-workbench-lazy-fetchers",
    );
  });
  return gate;
}

function successfulStage(): Response {
  return new Response(
    JSON.stringify({ schemaVersion: "1", status: "succeeded", actionKind: "stage" }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function stageInput(): GitDeliveryStageInput {
  return {
    projectId: "/private/repository",
    pathspecs: ["reviewed.ts"],
    includeUntracked: false,
    approval: {
      schemaVersion: "1",
      approvalId: "reviewed-approval",
      approvalToken: "a".repeat(64),
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock("./coding-workbench-lazy-fetchers");
});

afterEach(async () => {
  const diagnostics = await import("./client-diagnostics");
  diagnostics.resetClientDiagnosticWriter();
  vi.doUnmock("./coding-workbench-lazy-fetchers");
  vi.unstubAllGlobals();
});

describe("Git delivery lazy request boundary", () => {
  it("waits for the real delivery module before sending the reviewed request", async () => {
    const gate = holdGitDeliveryImport();
    const api = await import("./api");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(successfulStage());
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const pending = api.fetchGitDeliveryStage(stageInput(), controller.signal);
    try {
      await Promise.resolve();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      gate.release();
      await pending;
    }
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "/api/git-delivery/staging/stage",
      expect.objectContaining({ method: "POST", signal: controller.signal }),
    );
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("X-Keiko-CSRF")).toBe("1");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("keeps the original pathspecs and approval when caller input changes during module loading", async () => {
    const gate = holdGitDeliveryImport();
    const api = await import("./api");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(successfulStage());
    vi.stubGlobal("fetch", fetch);
    const pathspecs = ["reviewed.ts"];
    const approval = {
      schemaVersion: "1",
      approvalId: "reviewed-approval",
      approvalToken: "a".repeat(64),
    } satisfies NonNullable<GitDeliveryStageInput["approval"]>;
    const input = {
      projectId: "/private/repository",
      pathspecs,
      includeUntracked: false,
      approval,
    };
    const pending = api.fetchGitDeliveryStage(input);
    try {
      input.projectId = "/different/repository";
      input.includeUntracked = true;
      pathspecs.splice(0, 1, "unreviewed.ts", "extra.ts");
      approval.approvalId = "different-approval";
      approval.approvalToken = "b".repeat(64);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      gate.release();
      await pending;
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        schemaVersion: "1",
        projectId: "/private/repository",
        pathspecs: ["reviewed.ts"],
        includeUntracked: false,
        userInitiated: true,
        approval: stageInput().approval,
      }),
    );
  });

  it("does not send a delivery request when its caller aborts during module loading", async () => {
    const gate = holdGitDeliveryImport();
    const api = await import("./api");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(successfulStage());
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const reason = new DOMException("Caller cancelled delivery", "AbortError");
    const pending = api.fetchGitDeliveryStage(stageInput(), controller.signal);
    const rejected = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    gate.release();
    await rejected;
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a failed delivery import with a body-free correlated diagnostic and no HTTP effect", async () => {
    vi.doMock("./coding-workbench-lazy-fetchers", () => {
      throw new TypeError("private chunk URL /private/repository reviewed.ts");
    });
    const api = await import("./api");
    const diagnostics = await import("./client-diagnostics");
    const writer = vi.fn<ClientDiagnosticWriter>();
    diagnostics.setClientDiagnosticWriter(writer);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(successfulStage());
    vi.stubGlobal("fetch", fetch);
    const pending = api.fetchGitDeliveryStage(stageInput());
    await expect(pending).rejects.toMatchObject({
      code: "MODULE_LOAD_FAILED",
      status: 0,
      correlationId: expect.any(String),
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(writer).toHaveBeenCalledExactlyOnceWith(
      "git:module-load-failed",
      expect.objectContaining({
        moduleLoadFailure: "git-sync",
        errorKind: "unavailable",
        correlationId: expect.any(String),
        errorEvidence: expect.objectContaining({ causeChain: ["TypeError"] }),
      }),
    );
    await expect(pending).rejects.toMatchObject({
      correlationId: writer.mock.calls[0]?.[1]?.correlationId,
    });
    expect(JSON.stringify(writer.mock.calls)).not.toMatch(
      /private chunk URL|private\/repository|reviewed\.ts|reviewed-approval|aaaaaaaa/,
    );
  });
});
