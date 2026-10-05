import { describe, expect, it, vi } from "vitest";
import type { SelectedScope } from "@oscharko-dev/keiko-contracts/connected-context";
import { extractAnchors } from "./anchors.js";
import { classifyRetrievalIntent } from "./intent.js";
import { createExplorationPlan } from "./plan.js";

const scope: SelectedScope = {
  schemaVersion: "1",
  scopeId: "review-routing",
  workspaceRoot: "/work",
  kind: "workspace-root",
  relativePaths: [],
  explicitConnection: true,
  conversationId: undefined,
  connectedAtMs: 1,
};
function plan(text: string): ReturnType<typeof createExplorationPlan> {
  return createExplorationPlan(
    {
      scope,
      query: {
        kind: "natural-language",
        text,
        caseSensitive: false,
        maxResults: 20,
        emittedAtMs: 1,
      },
    },
    { nowMs: () => 1 },
  );
}
describe("planner reviewed query routing", () => {
  it.each(["Tell me everything about the login flow", "Zeig mir alles zur Authentifizierung"])(
    "preserves the topic after an overview-like introduction: %s",
    (text) => {
      expect(classifyRetrievalIntent(text).intent).toBe("targeted-code-search");
    },
  );
  it.each(["Tell me everything", "Zeig mir alles!", "Please tell me everything."])(
    "retains genuine repository orientation: %s",
    (text) => {
      expect(classifyRetrievalIntent(text).intent).toBe("repository-overview");
    },
  );
  it.each(["List all 500 files", "Read ADR-404", "What is on line 503?"])(
    "does not infer an HTTP failure from an unrelated number: %s",
    (text) => {
      expect(classifyRetrievalIntent(text).intent).not.toBe("diagnostic-search");
    },
  );
  it.each(["HTTP 503", "status code 404", "response status 500"])(
    "preserves status diagnostics: %s",
    (text) => {
      expect(classifyRetrievalIntent(text).intent).toBe("diagnostic-search");
    },
  );
  it.each(['"db"', "`fs`", "/v1"])("admits a concrete short target: %s", (text) => {
    const result = plan(text);
    expect(result.state).toBe("ready");
    expect(result.anchors).not.toHaveLength(0);
    expect(result.rings[0]?.kind).toBe("lexical");
  });
  it.each(["lab_manual.html", "test_data.json", "README_FIRST.md", "user_service.py"])(
    "preserves the complete snake-case filename: %s",
    (name) => {
      expect(extractAnchors({ text: `Read ${name}`, maxAnchors: 8 }).anchors).toContainEqual({
        term: name.toLowerCase(),
        kind: "identifier",
        weight: 0.8,
      });
    },
  );
  it.each([
    ["Read lab_manual.html.", "lab_manual.html"],
    ["Open user_service.py.", "user_service.py"],
    ["Read user_service.test.ts", "user_service.test.ts"],
    ["Read my_file.tar.gz", "my_file.tar.gz"],
    ["Read foo_bar.d.ts", "foo_bar.d.ts"],
    ["Read my-app_config.v2.json", "my-app_config.v2.json"],
    ["Read über_service.ts.", "über_service.ts"],
    ["Read my-app-config.ts.", "my-app-config.ts"],
  ])("preserves a complete filename without fragment anchors: %s", (text, filename) => {
    const anchors = extractAnchors({ text, maxAnchors: 8 }).anchors;
    expect(anchors.filter((anchor) => anchor.kind !== "literal")).toEqual([
      { term: filename, kind: "identifier", weight: 0.8 },
    ]);
    expect(anchors.filter((anchor) => anchor.kind === "literal")).toEqual([
      { term: text.startsWith("Open") ? "open" : "read", kind: "literal", weight: 0.5 },
    ]);
  });
  it.each([
    "'UserService'の定義はどこ",
    "'UserService'是什麼",
    "查找'UserService'定义",
    "'UserService'の",
    "'UserService'は",
    "'UserService'가",
  ])("retains quoted targets adjacent to CJK text: %s", (text) => {
    expect(extractAnchors({ text, maxAnchors: 8 }).anchors).toContainEqual({
      term: "userservice",
      kind: "quoted",
      weight: 1,
    });
  });
  it("uses the same locale-independent ordering for anchor intake and plan identity", () => {
    const text = '"ö" "å" "ä" "z"';
    const before = plan(text);
    const comparison = vi.spyOn(String.prototype, "localeCompare").mockReturnValue(-1);
    try {
      expect(extractAnchors({ text, maxAnchors: 2 }).anchors.map((anchor) => anchor.term)).toEqual([
        "z",
        "ä",
      ]);
      expect(plan(text).planId).toBe(before.planId);
      expect(comparison).not.toHaveBeenCalled();
    } finally {
      comparison.mockRestore();
    }
  });
});
