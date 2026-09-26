import { describe, expect, it } from "vitest";

import type {
  LanguageServiceOperation,
  ManagedLspEffectiveState,
  ManagedLspLanguage,
} from "@oscharko-dev/keiko-contracts";
import { LANGUAGE_SERVICE_OPERATIONS } from "@oscharko-dev/keiko-contracts/runtime/language-service";
import {
  MANAGED_LSP_EFFECTIVE_STATES,
  MANAGED_LSP_LANGUAGES,
} from "@oscharko-dev/keiko-contracts/runtime/managed-lsp-activation";

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

const SPAWNABLE_STATES: ReadonlySet<ManagedLspEffectiveState> = new Set([
  "available",
  "starting",
  "active",
  "degraded",
]);

type CellDisposition = "executed" | "unsupported-by-candidate" | "blocked-by-state";

interface ProviderOperationStateCell {
  readonly language: ManagedLspLanguage;
  readonly operation: LanguageServiceOperation;
  readonly state: ManagedLspEffectiveState;
  readonly disposition: CellDisposition;
}

function operationsFor(language: ManagedLspLanguage): readonly LanguageServiceOperation[] {
  return (
    HOST_LANGUAGE_PROVIDER_SPECS.find((spec) => spec.languages.includes(language))?.operations ?? []
  );
}

function dispositionFor(
  language: ManagedLspLanguage,
  operation: LanguageServiceOperation,
  state: ManagedLspEffectiveState,
): CellDisposition {
  if (!SPAWNABLE_STATES.has(state)) return "blocked-by-state";
  return operationsFor(language).includes(operation) ? "executed" : "unsupported-by-candidate";
}

function providerOperationStateCells(): readonly ProviderOperationStateCell[] {
  return MANAGED_LSP_LANGUAGES.flatMap((language) =>
    LANGUAGE_SERVICE_OPERATIONS.flatMap((operation) =>
      MANAGED_LSP_EFFECTIVE_STATES.map((state) => ({
        language,
        operation,
        state,
        disposition: dispositionFor(language, operation, state),
      })),
    ),
  );
}

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

  it("assigns an explicit disposition to all 675 provider-operation-state cells", () => {
    const cells = providerOperationStateCells();
    expect(cells).toHaveLength(
      MANAGED_LSP_LANGUAGES.length *
        LANGUAGE_SERVICE_OPERATIONS.length *
        MANAGED_LSP_EFFECTIVE_STATES.length,
    );
    expect(cells).toHaveLength(675);
    expect(cells.every((cell) => cell.disposition.length > 0)).toBe(true);
  });

  it("executes only candidate operations in spawnable states", () => {
    for (const cell of providerOperationStateCells()) {
      const candidate = operationsFor(cell.language).includes(cell.operation);
      const executable = SPAWNABLE_STATES.has(cell.state) && candidate;
      expect(cell.disposition === "executed", JSON.stringify(cell)).toBe(executable);
    }
  });

  it("fails closed for non-spawnable states and keeps unsupported cells explicit", () => {
    for (const cell of providerOperationStateCells()) {
      if (!SPAWNABLE_STATES.has(cell.state)) {
        expect(cell.disposition, JSON.stringify(cell)).toBe("blocked-by-state");
      } else if (!operationsFor(cell.language).includes(cell.operation)) {
        expect(cell.disposition, JSON.stringify(cell)).toBe("unsupported-by-candidate");
      }
    }
  });
});
