import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import { CODING_WORKBENCH_RUNTIME_MODEL_ID_MAX_CHARS } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import {
  CODING_MODEL_STORAGE_KEY,
  offeredSavedCodingModel,
  rememberCodingModel,
  savedCodingModel,
} from "./codingModelPreference";

const reportClientDiagnostic = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-diagnostics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-diagnostics")>()),
  reportClientDiagnostic,
}));

function model(id: string): ModelCapability {
  return { id } as ModelCapability;
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.removeItem(CODING_MODEL_STORAGE_KEY);
});

describe("coding model preference", () => {
  it("restores an explicitly remembered model only while it is offered", () => {
    rememberCodingModel("gemma-4-31b-it");

    expect(savedCodingModel()).toBe("gemma-4-31b-it");
    expect(offeredSavedCodingModel([model("gpt-5.4"), model("gemma-4-31b-it")])?.id).toBe(
      "gemma-4-31b-it",
    );
    expect(offeredSavedCodingModel([model("gpt-5.4")])).toBeUndefined();
  });

  it("keeps the saved choice when no model is chosen", () => {
    rememberCodingModel("gemma-4-31b-it");
    rememberCodingModel(null);

    expect(savedCodingModel()).toBe("gemma-4-31b-it");
  });

  it.each([
    ["an empty identifier", ""],
    ["padded text", " gemma "],
    ["a control character", "gemma\u0007"],
    ["an oversized identifier", "m".repeat(CODING_WORKBENCH_RUNTIME_MODEL_ID_MAX_CHARS + 1)],
  ])("ignores %s found in storage and never writes one", (_label, value) => {
    window.localStorage.setItem(CODING_MODEL_STORAGE_KEY, value);
    expect(savedCodingModel()).toBeNull();

    window.localStorage.removeItem(CODING_MODEL_STORAGE_KEY);
    rememberCodingModel(value);
    expect(window.localStorage.getItem(CODING_MODEL_STORAGE_KEY)).toBeNull();
  });

  it("reports unusable browser storage with closed, body-free evidence", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });

    expect(savedCodingModel()).toBeNull();
    rememberCodingModel("gemma-4-31b-it");

    expect(reportClientDiagnostic).toHaveBeenNthCalledWith(
      1,
      "[keiko] coding workbench model preference read failed",
      expect.objectContaining({ kind: "other", errorKind: "unavailable" }),
    );
    expect(reportClientDiagnostic).toHaveBeenNthCalledWith(
      2,
      "[keiko] coding workbench model preference write failed",
      expect.objectContaining({
        errorEvidence: expect.objectContaining({ errorClass: "QuotaExceededError" }),
      }),
    );
    const reported = JSON.stringify(reportClientDiagnostic.mock.calls);
    expect(reported).not.toContain("gemma-4-31b-it");
  });
});
