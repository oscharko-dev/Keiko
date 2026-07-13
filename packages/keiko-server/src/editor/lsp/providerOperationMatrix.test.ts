import { describe, expect, it } from "vitest";

import type { LanguageServiceOperation } from "@oscharko-dev/keiko-contracts";

import { HOST_LANGUAGE_PROVIDER_SPECS } from "./hostLanguageProviders.js";
import { providerConformanceRequests } from "./testing/providerConformanceFixture.js";

const FULL: readonly LanguageServiceOperation[] = [
  "diagnostics",
  "completion",
  "hover",
  "symbols",
  "formatting",
  "definition",
  "typeDefinition",
  "implementation",
  "references",
  "callHierarchy",
  "inlayHints",
  "renamePrepare",
  "renameApply",
  "codeActions",
  "signatureHelp",
];

const MATRIX: Readonly<Record<string, readonly LanguageServiceOperation[]>> = {
  "python-lsp": FULL.filter((operation) => operation !== "formatting"),
  "go-lsp": FULL,
  "shell-lsp": ["diagnostics", "completion", "hover", "symbols", "definition", "references"],
  "java-lsp": FULL,
  "rust-lsp": FULL,
};

describe("managed provider operation matrix", () => {
  it("pins every provider candidate cell to its conformance-backed surface", () => {
    const actual = Object.fromEntries(
      HOST_LANGUAGE_PROVIDER_SPECS.map((spec) => [spec.id, [...spec.operations].sort()]),
    );
    const expected = Object.fromEntries(
      Object.entries(MATRIX).map(([id, operations]) => [id, [...operations].sort()]),
    );
    expect(actual).toEqual(expected);
  });

  it("has one bounded shared request fixture for every advertised operation", () => {
    const requests = providerConformanceRequests({
      root: "/workspace",
      path: "fixture.txt",
      languageId: "plaintext",
      text: "value",
      includeFormatting: true,
    });
    const operations = new Set(requests.map((request) => request.operation));
    for (const candidates of Object.values(MATRIX)) {
      for (const operation of candidates) expect(operations.has(operation), operation).toBe(true);
    }
    expect(operations).toEqual(new Set(FULL));
  });
});
