import { describe, expect, it } from "vitest";
import {
  createDefaultChatCapability,
  type GatewayCallRequest,
} from "@oscharko-dev/keiko-model-gateway";
import { canonicalCommitBody, prepareCommitDraft } from "./commitDraftQuality.js";

function build(diff: string, compacted: boolean): GatewayCallRequest {
  return {
    modelId: "fixture",
    maxOutputTokens: 1024,
    messages: [{ role: "user", content: JSON.stringify({ diff, compacted }) }],
  };
}

const capability = { ...createDefaultChatCapability("fixture"), contextWindow: 8192 };

describe("commit draft evidence bounds", () => {
  it("preserves complete small diffs", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+change";
    const prepared = prepareCommitDraft(patch, capability, build);
    expect(prepared?.diffCompacted).toBe(false);
    expect(prepared?.request).toEqual(build(patch, false));
  });

  it("counts the response schema as part of the input budget", () => {
    const plain = prepareCommitDraft("+change", capability, build);
    const structured = prepareCommitDraft("+change", capability, (diff, compacted) => ({
      ...build(diff, compacted),
      responseFormat: {
        type: "json_schema",
        name: "draft",
        strict: true,
        schema: { type: "object", properties: { subject: { type: "string" } } },
      },
    }));
    expect(structured?.promptTokens).toBeGreaterThan(plain?.promptTokens ?? 0);
  });

  it("retains beginning and end evidence for a large single file, including Unicode", () => {
    const patch = `diff --git a/a.ts b/a.ts\n+start-evidence\n${"+漢字änderung\n".repeat(12_000)}+end-evidence`;
    const prepared = prepareCommitDraft(patch, capability, build);
    expect(prepared?.request.messages[0]?.content).toContain("start-evidence");
    expect(prepared?.request.messages[0]?.content).toContain("end-evidence");
    expect(prepared?.promptTokens).toBeLessThanOrEqual(prepared?.maxPromptTokens ?? 0);
    expect(prepared?.diffCompacted).toBe(true);
  });

  it("refuses an impossible prompt instead of silently dropping selected files", () => {
    expect(
      prepareCommitDraft("+change", { ...capability, contextWindow: 16 }, build),
    ).toBeUndefined();
  });

  it("bounds an unsectioned patch without losing the omission marker", () => {
    const prepared = prepareCommitDraft("+change\n".repeat(20_000), capability, build);
    expect(prepared?.diffCompacted).toBe(true);
    expect(prepared?.request.messages[0]?.content).toContain("Additional diff lines omitted");
  });
});

describe("canonical commit body", () => {
  it("normalizes bullet markers, Windows newlines and wrapped paragraphs idempotently", () => {
    const expected = "- First change.\n- Second change.\n- Third change with context.";
    const result = canonicalCommitBody(
      "* First change.  \r\n\r\n2) Second change.\n\nThird change\nwith context.",
    );
    expect(result).toBe(expected);
    expect(canonicalCommitBody(result)).toBe(expected);
  });
});
