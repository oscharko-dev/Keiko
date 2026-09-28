import { describe, expect, it, vi } from "vitest";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import {
  createDefaultChatCapability,
  type GatewayCallRequest,
} from "@oscharko-dev/keiko-model-gateway";
import {
  canonicalCommitBody as normalizeCommitBody,
  prepareCommitDraft,
} from "./commitDraftQuality.js";

// Keep the exact-output/idempotence pins over the text projection of the production result.
function canonicalCommitBody(body: string): string {
  return normalizeCommitBody(body).body;
}

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
    if (structured.request === undefined) throw new Error("Missing prepared request");
    expect(structured.promptTokens).toBe(
      countGatewayPromptTokens(structured.request, capability.tokenAccounting),
    );
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
  it.each([
    [
      "- Update the parser.\n\nNote: the lexer is unchanged.\n\n* Add regression tests\n* Update the\n  migration docs",
      "- Update the parser.\n- Note: the lexer is unchanged.\n- Add regression tests\n- Update the migration docs",
    ],
    [
      "Summary: rework the parser.\n\n* Add regression tests\n* Update docs",
      "- Summary: rework the parser.\n- Add regression tests\n- Update docs",
    ],
    [
      "Context: preserve compatibility.\n\nExplain the\nreason.\n\nRefs #123",
      "- Context: preserve compatibility.\n- Explain the reason.\n\nRefs #123",
    ],
    [
      "- Update parser.\n\nNote: unchanged lexer.\n\n2) Add tests.\n\nSigned-off-by: Dev <dev@example.invalid>",
      "- Update parser.\n- Note: unchanged lexer.\n- Add tests.\n\nSigned-off-by: Dev <dev@example.invalid>",
    ],
  ])("normalizes trailer-like prose before later body paragraphs: %s", (body, expected) => {
    expect(canonicalCommitBody(body)).toBe(expected);
    expect(canonicalCommitBody(expected)).toBe(expected);
  });

  it("preserves the final footer group with separate tokens and indented continuation paragraphs", () => {
    const footer =
      "Custom: migration details.\nUnwrapped continuation.\n\n  Indented continuation paragraph.\n\nRefs #123\n\nSigned-off-by: Dev <dev@example.invalid>";
    const body = `- Update parser.\n\n${footer}`;
    expect(canonicalCommitBody(body)).toBe(body);
    expect(canonicalCommitBody(canonicalCommitBody(body))).toBe(body);
  });

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

// Footer values can continue across lines; formatting must retain the major-change marker.
it.each([
  "BREAKING CHANGE: v1 removed.\n  Migrate to v2.",
  "BREAKING-CHANGE: v1 removed.\nMigrate to v2.\n\nMigration details.\nSigned-off-by: Dev <dev@example.invalid>",
])("preserves multiline footer values: %s", (footer) => {
  const body = `- Drop v1.\n\n${footer}`;
  expect(canonicalCommitBody(body)).toBe(body);
  expect(canonicalCommitBody(canonicalCommitBody(body))).toBe(body);
});

it("retains the measured smaller prompt when all file headers still exceed context", () => {
  const patch = Array.from(
    { length: 800 },
    (_, index) =>
      `diff --git a/file${String(index)} b/file${String(index)}\n+${"change".repeat(100)}`,
  ).join("\n");
  const observedBuild = vi.fn(build);
  const prepared = prepareCommitDraft(patch, capability, observedBuild);
  const lastBuild = observedBuild.mock.results.at(-1);
  if (lastBuild?.type !== "return") throw new Error("Expected the minimum candidate build");
  const minimum = lastBuild.value;
  expect(prepared.request).toBeUndefined();
  expect(prepared.diffCompacted).toBe(true);
  expect(prepared.promptTokens).toBe(countGatewayPromptTokens(minimum, capability.tokenAccounting));
  expect(prepared.promptTokens).toBeGreaterThan(prepared.maxPromptTokens);
  expect(prepared.promptTokens).toBeLessThan(
    countGatewayPromptTokens(build(patch, false), capability.tokenAccounting),
  );
});

it("normalizes trailer tokens while retaining continuation indentation and reference separators", () => {
  const expected =
    "- Fix parser.\n\nBREAKING CHANGE: v1 removed.\n  Migrate to v2.\nRefs #123\nSigned-off-by: Dev <dev@example.invalid>";
  expect(
    canonicalCommitBody(
      "- Fix parser.\n\n  BREAKING CHANGE: v1 removed.  \n  Migrate to v2.  \n  Refs #123  \n  Signed-off-by: Dev <dev@example.invalid>",
    ),
  ).toBe(expected);
  expect(canonicalCommitBody(expected)).toBe(expected);
});

it.each(["BREAKING CHANGE", "BREAKING-CHANGE", "Migration"])(
  "retains token-shaped continuations inside a %s footer",
  (token) => {
    const body = `- Drop v1.\n\n${token}: v1 removed.\n  Migration: use v2.\n  Refs #123\nSigned-off-by: Dev <dev@example.invalid>`;
    expect(canonicalCommitBody(body)).toBe(body);
    expect(canonicalCommitBody(canonicalCommitBody(body))).toBe(body);
  },
);

it.each(["Refs #123", "Refs: #123", "Reviewed-by: Dev <dev@example.invalid>"])(
  "preserves unindented paragraphs in the explicit %s footer",
  (token) => {
    const body = `- Fix parser.\n\n${token}\n\nFurther details.\nMore details.\n\nSigned-off-by: Dev <dev@example.invalid>`;
    expect(canonicalCommitBody(body)).toBe(body);
    expect(canonicalCommitBody(canonicalCommitBody(body))).toBe(body);
  },
);

it("keeps an indented reference inside ambiguous prose from claiming later body paragraphs", () => {
  const body = "- Fix parser.\n\nNote: more context.\n\n  Refs #123\n\nExplain the reason.";
  const expected = "- Fix parser.\n- Note: more context.\n- Refs #123\n- Explain the reason.";
  expect(canonicalCommitBody(body)).toBe(expected);
  expect(canonicalCommitBody(expected)).toBe(expected);
});
