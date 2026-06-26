// Issue #1381 AC2 (ADR-0069 D5) — proves the manager-derived `LanguageProvider` flows through the
// existing `describeLanguageCapabilities()` path WITHOUT any UI change: a READY manager surfaces as an
// available descriptor, every non-READY status surfaces as unavailable with a content-free reason, and
// the capability projection never throws even when the backing status is an error. The mapping is pure
// (`lspStatusToProviderDescriptor`), so the same status always yields the same descriptor.

import { describe, expect, it } from "vitest";

import { lspStatusToProviderDescriptor } from "@oscharko-dev/keiko-contracts";
import type { LanguageServiceOperation, LspProcessStatus } from "@oscharko-dev/keiko-contracts";

import { LSP_PROCESS_STATUSES } from "@oscharko-dev/keiko-contracts";
import { buildLanguageProvider } from "./lspLanguageProvider.js";
import { createLanguageProviderRegistry } from "../languageProvider.js";
import { describeLanguageCapabilities } from "../languageService.js";

const LANGUAGES: readonly string[] = ["python"];
const OPERATIONS: readonly LanguageServiceOperation[] = ["hover"];

function capabilitiesForStatus(
  status: LspProcessStatus,
): ReturnType<typeof describeLanguageCapabilities> {
  const provider = buildLanguageProvider("mgr-int", LANGUAGES, OPERATIONS, () => status);
  const registry = createLanguageProviderRegistry([provider]);
  return describeLanguageCapabilities(registry);
}

function pythonDescriptor(status: LspProcessStatus): {
  readonly availability: string;
  readonly unavailableReason?: string | undefined;
} {
  const descriptor = capabilitiesForStatus(status).providers.find(
    (entry) => entry.id === "mgr-int" && entry.languages.includes("python"),
  );
  if (descriptor === undefined) throw new Error("expected the manager descriptor");
  return descriptor;
}

describe("lsp status → language capabilities integration", () => {
  it("reports the language as available when the manager is READY", () => {
    const descriptor = pythonDescriptor("READY");

    expect(descriptor.availability).toBe("available");
    expect(descriptor.unavailableReason).toBeUndefined();
  });

  it("reports unavailable with a content-free reason when the manager is CRASHED", () => {
    const descriptor = pythonDescriptor("CRASHED");

    expect(descriptor.availability).toBe("unavailable");
    expect(descriptor.unavailableReason).toBe("CRASHED");
  });

  it("never throws and stays unavailable for every error/terminal status", () => {
    for (const status of LSP_PROCESS_STATUSES) {
      if (status === "READY") continue;
      const run = (): ReturnType<typeof pythonDescriptor> => pythonDescriptor(status);

      expect(run).not.toThrow();
      expect(run().availability).toBe("unavailable");
      expect(run().unavailableReason).toBe(status);
    }
  });

  it("maps purely: the same status yields an identical descriptor", () => {
    const first = lspStatusToProviderDescriptor("mgr-int", LANGUAGES, OPERATIONS, "READY");
    const second = lspStatusToProviderDescriptor("mgr-int", LANGUAGES, OPERATIONS, "READY");

    expect(first).toEqual(second);
  });
});
