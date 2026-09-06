import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@oscharko-dev/keiko-contracts";
import { EDITOR_AGENT_TOOL_DEFINITIONS } from "@oscharko-dev/keiko-tools";
import { compileToolProjection, createKeikoToolCatalog } from "@oscharko-dev/keiko-tool-catalog";
import { createHarnessCatalogBudget } from "./catalog-budget.js";
import { newCounters } from "./context.js";
import {
  classifyEditorAgentCatalogResult,
  createEditorAgentCatalogFactory,
  editorAgentRegistrationSet,
} from "./editor-agent-catalog.js";
import { DEFAULT_LIMITS } from "./types.js";
import type { ToolCallResult, ToolPort } from "./ports.js";

function classify(payload: unknown): ReturnType<typeof classifyEditorAgentCatalogResult> {
  return classifyEditorAgentCatalogResult({
    toolCallId: "call-1",
    output: JSON.stringify(payload),
    durationMs: 1,
  });
}

describe("editor agent registration set", () => {
  it("declares all nine editor descriptors under the reserved ADR-0175 identities", () => {
    const set = editorAgentRegistrationSet();
    expect(set.entries).toHaveLength(9);
    expect(set.entries.map((entry) => entry.alias)).toEqual(
      EDITOR_AGENT_TOOL_DEFINITIONS.map((definition) => definition.name),
    );
    const canonicalIds = set.entries.map((entry) => entry.descriptor.toolRef.canonicalId);
    expect(new Set(canonicalIds).size).toBe(9);
    expect(canonicalIds.every((id) => id.startsWith("keiko.editor."))).toBe(true);
  });

  it("maps every alias to its exact reserved canonical identity, not merely a unique one", () => {
    // Guards against a future reorder of EDITOR_AGENT_TOOL_DEFINITIONS silently misassigning
    // identities: this pins the explicit name -> canonicalId correspondence itself, not just
    // count/uniqueness (which a positional zip would also satisfy after a reorder).
    const set = editorAgentRegistrationSet();
    const canonicalIdByAlias = Object.fromEntries(
      set.entries.map((entry) => [entry.alias, entry.descriptor.toolRef.canonicalId]),
    );
    expect(canonicalIdByAlias).toEqual({
      editor_list_sessions: "keiko.editor.sessions",
      editor_snapshot: "keiko.editor.snapshot",
      editor_navigate: "keiko.editor.navigate",
      editor_navigate_symbol: "keiko.editor.symbol",
      editor_search_workspace: "keiko.editor.search",
      editor_git_context: "keiko.editor.git",
      editor_propose_edit: "keiko.editor.edit",
      editor_propose_changeset: "keiko.editor.changeset",
      editor_request_verification: "keiko.editor.verify",
    });
  });

  it("projects into a compilable catalog with the exact editor alias set", () => {
    const set = editorAgentRegistrationSet();
    const catalog = createKeikoToolCatalog([set]);
    const projection = compileToolProjection(catalog, { id: "editor", version: 1 });
    expect(projection.tools.map((tool) => tool.alias).sort()).toEqual(
      [...EDITOR_AGENT_TOOL_DEFINITIONS.map((definition) => definition.name)].sort(),
    );
  });

  it("classifies verification as its own effect and every other tool as workspace-read", () => {
    const set = editorAgentRegistrationSet();
    const verification = set.entries.find((entry) => entry.alias === "editor_request_verification");
    expect(verification?.descriptor.effects).toEqual(["verification"]);
    for (const entry of set.entries) {
      if (entry.alias === "editor_request_verification") continue;
      expect(entry.descriptor.effects).toEqual(["workspace-read"]);
    }
  });

  it("widens rather than narrows a real schema with unsupported keywords (search_workspace)", () => {
    const set = editorAgentRegistrationSet();
    const search = set.entries.find((entry) => entry.alias === "editor_search_workspace");
    if (search === undefined) throw new TypeError("Missing editor_search_workspace descriptor");
    // The real schema declares `mode` required with an enum and gives `caseSensitive` a default;
    // the catalog projection must keep the enum (still supported) and merely drop the default
    // (unsupported), never rejecting an argument shape the real handler accepts.
    const properties = search.descriptor.inputSchema.properties as Record<string, unknown>;
    // compileCatalogSchema sorts enum values canonically -- this pins content, not source order.
    expect((properties.mode as Record<string, unknown>).enum).toEqual(["regex", "symbol", "text"]);
    expect((properties.caseSensitive as Record<string, unknown>).default).toBeUndefined();
    expect(search.descriptor.inputSchema.required).toContain("mode");
  });

  it("advertises only the allowed ready subset exposed by the bound editor port", () => {
    const activeAliases = new Set([
      "editor_navigate_symbol",
      "editor_search_workspace",
      "editor_git_context",
      "editor_request_verification",
    ]);
    const port: ToolPort = {
      listTools: (): readonly ToolDefinition[] =>
        EDITOR_AGENT_TOOL_DEFINITIONS.filter((definition) => activeAliases.has(definition.name)),
      execute: (): Promise<ToolCallResult> => Promise.reject(new Error("not exercised")),
    };
    const controller = new AbortController();
    const budget = createHarnessCatalogBudget({
      runId: "editor-catalog-subset",
      signal: controller.signal,
      counters: newCounters(),
      limits: DEFAULT_LIMITS,
      now: () => 0,
      deadlineAt: 1_000,
    });
    const catalogPort = createEditorAgentCatalogFactory(port)({
      runId: "editor-catalog-subset",
      signal: controller.signal,
      budgetPort: budget.port,
      observeExecution: () => undefined,
    });
    const advertisement = catalogPort.offer();
    expect(advertisement.projection.tools.map((tool) => tool.alias).sort()).toEqual(
      [...activeAliases].sort(),
    );
    expect(advertisement.offered.toolRefs).toEqual(
      advertisement.projection.tools.map((tool) => tool.toolRef),
    );
  });
});

describe("editor catalog settlement classification", () => {
  it("distinguishes successful action, governed conflict, and structured host failure", () => {
    expect(
      classify({
        ok: true,
        kind: "action-result",
        result: {
          schemaVersion: "1",
          actionId: "action-1",
          sessionId: "session-1",
          status: "succeeded",
        },
      }),
    ).toEqual({ status: "completed", reason: "none" });
    expect(
      classify({
        ok: true,
        kind: "action-result",
        result: {
          schemaVersion: "1",
          actionId: "action-2",
          sessionId: "session-1",
          status: "conflict",
          conflict: { code: "NO_ACTIVE_BRIDGE", message: "Unavailable." },
        },
      }),
    ).toEqual({ status: "failed", reason: "handler-unavailable" });
    expect(classify({ ok: false, error: { kind: "host", code: "HOST_FAILURE" } })).toEqual({
      status: "failed",
      reason: "handler-failed",
    });
  });

  it.each([
    ["cancelled", { status: "cancelled", reason: "explicit-cancellation" }],
    ["invalid-arguments", { status: "invalid", reason: "invalid-arguments" }],
    ["malformed-response", { status: "failed", reason: "result-contract-failed" }],
  ] as const)("maps the %s failure kind into the closed catalog vocabulary", (kind, expected) => {
    expect(classify({ ok: false, error: { kind, code: "BODY_FREE" } })).toEqual(expected);
  });

  it("fails closed when the legacy output is malformed", () => {
    expect(
      classifyEditorAgentCatalogResult({ toolCallId: "call-1", output: "{", durationMs: 1 }),
    ).toEqual({ status: "failed", reason: "result-contract-failed" });
  });
});
