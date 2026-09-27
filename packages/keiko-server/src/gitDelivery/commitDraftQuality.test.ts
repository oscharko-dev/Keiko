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
    expect(prepared.diffCompacted).toBe(false);
    expect(prepared.request).toEqual(build(patch, false));
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
    expect(structured.promptTokens).toBeGreaterThan(plain.promptTokens);
  });

  it("retains beginning and end evidence for a large single file, including Unicode", () => {
    const patch = `diff --git a/a.ts b/a.ts\n+start-evidence\n${"+漢字änderung\n".repeat(12_000)}+end-evidence`;
    const prepared = prepareCommitDraft(patch, capability, build);
    expect(prepared.request?.messages[0]?.content).toContain("start-evidence");
    expect(prepared.request?.messages[0]?.content).toContain("end-evidence");
    expect(prepared.promptTokens).toBeLessThanOrEqual(prepared.maxPromptTokens);
    expect(prepared.diffCompacted).toBe(true);
  });

  it("refuses an impossible prompt instead of silently dropping selected files", () => {
    expect(
      prepareCommitDraft("+change", { ...capability, contextWindow: 16 }, build),
    ).toMatchObject({ request: undefined });
  });

  it("bounds an unsectioned patch without losing the omission marker", () => {
    const prepared = prepareCommitDraft("+change\n".repeat(20_000), capability, build);
    expect(prepared.diffCompacted).toBe(true);
    expect(prepared.request?.messages[0]?.content).toContain("Additional diff lines omitted");
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

describe("review regressions for large selections and commit trailers", () => {
  it("fits hundreds of files using their complete headers when excerpts cannot fit", () => {
    const headers = Array.from(
      { length: 250 },
      (_, index) => `diff --git a/f${String(index)} b/f${String(index)}`,
    );
    const patch = headers.map((header) => `${header}\n+${"change".repeat(100)}`).join("\n");
    const prepared = prepareCommitDraft(patch, capability, build);
    expect(prepared).toBeDefined();
    expect(prepared.promptTokens).toBeLessThanOrEqual(prepared.maxPromptTokens);
    for (const header of headers) expect(prepared.request?.messages[0]?.content).toContain(header);
  });

  it("preserves a trailing signoff block without turning it into list items", () => {
    const trailer = "Signed-off-by: Dev <dev@example.invalid>";
    const result = canonicalCommitBody(
      `* Fix the workflow.\n\n${trailer}\nCo-authored-by: Reviewer <reviewer@example.invalid>`,
    );
    expect(result).toBe(
      `- Fix the workflow.\n\n${trailer}\nCo-authored-by: Reviewer <reviewer@example.invalid>`,
    );
    expect(canonicalCommitBody(result)).toBe(result);
  });
});

it.each(["BREAKING CHANGE", "BREAKING-CHANGE"])("preserves the %s footer verbatim", (token) => {
  const body = `- Drop the v1 export.\n\n${token}: the v1 export is removed.\nSigned-off-by: Dev <dev@example.invalid>`;
  expect(canonicalCommitBody(body)).toBe(body);
  expect(canonicalCommitBody(canonicalCommitBody(body))).toBe(body);
});

describe("commit trailer paragraph boundaries", () => {
  it.each(["Note: behavior unchanged.", "BREAKING CHANGE: remove the legacy parser."])(
    "keeps unseparated trailing prose in its paragraph: %s",
    (lastLine) => {
      const body = `- Refactor parser.\n${lastLine}`;
      const expected = `- Refactor parser. ${lastLine}`;
      expect(canonicalCommitBody(body)).toBe(expected);
      expect(canonicalCommitBody(expected)).toBe(expected);
    },
  );

  it("preserves a trailer-only body and a blank-line-separated trailer block", () => {
    const trailers =
      "Signed-off-by: Dev <dev@example.invalid>\nCo-authored-by: Reviewer <reviewer@example.invalid>";
    expect(canonicalCommitBody(trailers)).toBe(trailers);
    expect(canonicalCommitBody(`- Refactor parser.\n   \n${trailers}`)).toBe(
      `- Refactor parser.\n\n${trailers}`,
    );
  });
});
