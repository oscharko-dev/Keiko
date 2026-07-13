import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { LspLifecycleEvent } from "@oscharko-dev/keiko-contracts";

import { _resetLspLifecycleLedgerForTests, recordLspLifecycleEvent } from "./lspLifecycleLedger.js";
import { handleEditorLspStatus, isLspStatusTrusted } from "./lspStatusRoute.js";
import { matchRoute } from "../../routes.js";

function event(overrides: Partial<LspLifecycleEvent> = {}): LspLifecycleEvent {
  return {
    schemaVersion: "1",
    managerId: "mgr-1",
    status: "READY",
    timestampMs: 1_000,
    pendingRequestCount: 0,
    restartCount: 0,
    stderrBytesSeen: 0,
    ...overrides,
  };
}

interface StatusBody {
  readonly events: readonly LspLifecycleEvent[];
  readonly health: readonly unknown[];
}

describe("handleEditorLspStatus", () => {
  beforeEach(() => {
    _resetLspLifecycleLedgerForTests();
  });
  afterEach(() => {
    _resetLspLifecycleLedgerForTests();
  });

  it("returns 404 when the status surface is not enabled (default OFF)", () => {
    const result = handleEditorLspStatus(undefined, { env: {} });

    expect(result.status).toBe(404);
    expect(result.body).toEqual({
      error: { code: "NOT_FOUND", message: "The requested resource was not found." },
    });
  });

  it("returns 404 for a non-truthy env value (fail-closed on a typo)", () => {
    const result = handleEditorLspStatus(undefined, {
      env: { KEIKO_EDITOR_LSP_STATUS: "yes" },
    });

    expect(result.status).toBe(404);
  });

  it('returns 200 and the recorded events when enabled with "1"', () => {
    recordLspLifecycleEvent(event({ status: "STARTING" }));
    recordLspLifecycleEvent(event({ status: "READY" }));
    const result = handleEditorLspStatus(undefined, {
      env: { KEIKO_EDITOR_LSP_STATUS: "1" },
    });

    expect(result.status).toBe(200);
    const body = result.body as StatusBody;
    expect(body.events.map((entry) => entry.status)).toEqual(["STARTING", "READY"]);
    expect(body.health).toEqual([]);
  });

  it('returns 200 when enabled with "true"', () => {
    const result = handleEditorLspStatus(undefined, {
      env: { KEIKO_EDITOR_LSP_STATUS: "true" },
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ events: [], health: [] });
  });

  it("returns 200 with an empty list (not 404) when enabled and the ledger is empty", () => {
    const result = handleEditorLspStatus(undefined, {
      env: { KEIKO_EDITOR_LSP_STATUS: "1" },
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ events: [], health: [] });
  });

  it("serves already-redacted events (no raw secret in the body)", () => {
    const secret = "sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    recordLspLifecycleEvent(event({ managerId: secret }));
    const result = handleEditorLspStatus(undefined, {
      env: { KEIKO_EDITOR_LSP_STATUS: "1" },
    });

    expect(JSON.stringify(result.body)).not.toContain(secret);
  });

  describe("isLspStatusTrusted", () => {
    it.each<[string, EnvSource, boolean]>([
      ["missing", {}, false],
      ["empty", { KEIKO_EDITOR_LSP_STATUS: "" }, false],
      ["zero", { KEIKO_EDITOR_LSP_STATUS: "0" }, false],
      ["false", { KEIKO_EDITOR_LSP_STATUS: "false" }, false],
      ["one", { KEIKO_EDITOR_LSP_STATUS: "1" }, true],
      ["true", { KEIKO_EDITOR_LSP_STATUS: "true" }, true],
    ])("classifies %s", (_label, env, expected) => {
      expect(isLspStatusTrusted(env)).toBe(expected);
    });
  });

  it("is registered as a GET route in the API table", () => {
    const match = matchRoute("GET", "/api/editor/lsp/status");

    expect(match).not.toBeUndefined();
    expect(match).not.toBe("method-not-allowed");
  });
});
