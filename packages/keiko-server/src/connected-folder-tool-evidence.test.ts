import { describe, expect, it } from "vitest";
import { CONNECTED_CONTEXT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/connected-context";
import type { ConnectedContextPack, ContextExcerpt } from "@oscharko-dev/keiko-contracts";
import {
  CONNECTED_FOLDER_TOOL_READ_SELECTION_REASON,
  answerEvidencePacks,
  uncertaintyForSentEvidence,
  withConnectedFolderToolEvidence,
} from "./connected-folder-tool-evidence.js";
import type { ConnectedFolderToolWindow } from "./connectedFolderTool.js";
import { buildPackCitationIndex, reconcileInlineCitations } from "./grounded-faithfulness.js";

const NOW = 1_700_000_000_000;

function excerpt(scopePath: string, startLine: number, endLine: number): ContextExcerpt {
  const content = `lines ${String(startLine)}-${String(endLine)} of ${scopePath}`;
  return {
    atom: {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      stableId: `${scopePath}:${String(startLine)}-${String(endLine)}`,
      scopePath,
      lineRange: { startLine, endLine },
      score: 1,
      provenance: { kind: "lexical-search", tool: "repo.searchText", queryFingerprint: "fp" },
      redactionState: "redacted",
      emittedAtMs: NOW,
      ledgerRef: undefined,
    },
    content,
    contentBytes: Buffer.byteLength(content, "utf8"),
  };
}

function toolWindow(path: string, startLine: number, endLine: number): ConnectedFolderToolWindow {
  return { path, startLine, endLine, excerpt: excerpt(path, startLine, endLine) };
}

function pack(
  files: readonly { scopePath: string; excerpts: readonly ContextExcerpt[] }[],
): ConnectedContextPack {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: "pack-1",
    scope: {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      scopeId: "scope-1",
      workspaceRoot: "/connected",
      kind: "workspace-root",
      relativePaths: [],
      conversationId: "chat-1",
      connectedAtMs: NOW,
    },
    query: {
      kind: "natural-language",
      text: "what is in the folder?",
      caseSensitive: false,
      maxResults: 5,
      emittedAtMs: NOW,
    },
    budget: {
      searchCallsMax: 4,
      filesReadMax: 8,
      excerptBytesMax: 4096,
      modelInputTokensMax: 1000,
      modelOutputTokensMax: 500,
      elapsedMsMax: 5000,
      rerankCallsMax: 0,
    },
    usage: {
      searchCalls: 1,
      filesRead: files.length,
      excerptBytes: 64,
      modelInputTokens: 0,
      modelOutputTokens: 0,
      elapsedMs: 5,
      rerankCalls: 0,
    },
    files: files.map((file) => ({
      scopePath: file.scopePath,
      role: "read-only",
      selectionReason: "ranked",
      excerpts: file.excerpts,
    })),
    omitted: [{ scopePath: "docs/skipped.md", reason: "budget-exhausted", omittedAtMs: NOW }],
    uncertainty: [],
    emittedAtMs: NOW,
    ledgerRef: undefined,
  };
}

function unsupported(answer: string, packs: readonly ConnectedContextPack[]): readonly string[] {
  return reconcileInlineCitations(answer, buildPackCitationIndex(packs)).unsupported.map(
    (citation) => citation.scopePath,
  );
}

describe("evidence of a folder tool turn", () => {
  const sent = pack([{ scopePath: "docs/a.md", excerpts: [excerpt("docs/a.md", 1, 10)] }]);

  it("returns the sent packs untouched when the tool returned nothing", () => {
    const packs = [sent];
    expect(answerEvidencePacks(packs, sent, [])).toBe(packs);
    expect(withConnectedFolderToolEvidence(sent, [])).toBe(sent);
  });

  it("makes a tool-read window citable, and only the lines the model received", () => {
    const answer = "A [docs/a.md:3]. B [docs/b.md:40-45]. C [docs/b.md:46].";
    // Without the tool read, the second file is a source the model never received.
    expect(unsupported(answer, [sent])).toEqual(["docs/b.md", "docs/b.md"]);
    const merged = answerEvidencePacks([sent], sent, [toolWindow("docs/b.md", 40, 45)]);
    expect(merged).toHaveLength(1);
    // Line 46 was never returned by the tool and stays unsupported.
    const reconciled = reconcileInlineCitations(answer, buildPackCitationIndex(merged));
    expect(reconciled.unsupported.map((citation) => citation.lineRange)).toEqual([
      { startLine: 46, endLine: 46 },
    ]);
  });

  it("extends a file the retrieval already sent, so adjoining windows cover one citation", () => {
    const merged = withConnectedFolderToolEvidence(sent, [toolWindow("docs/a.md", 11, 30)]);
    expect(merged.files).toHaveLength(1);
    expect(merged.files[0]?.selectionReason).toBe("ranked");
    expect(merged.files[0]?.excerpts.map((entry) => entry.atom.lineRange)).toEqual([
      { startLine: 1, endLine: 10 },
      { startLine: 11, endLine: 30 },
    ]);
    expect(unsupported("X [docs/a.md:8-14].", [sent])).toEqual(["docs/a.md"]);
    expect(unsupported("X [docs/a.md:8-14].", [merged])).toEqual([]);
  });

  it("adds a file the retrieval did not send as a read-only tool read with its content", () => {
    const window = toolWindow("docs/b.md", 1, 5);
    const merged = withConnectedFolderToolEvidence(sent, [window]);
    expect(merged.files[1]).toEqual({
      scopePath: "docs/b.md",
      role: "read-only",
      selectionReason: CONNECTED_FOLDER_TOOL_READ_SELECTION_REASON,
      excerpts: [window.excerpt],
    });
  });

  it("does not add the same lines twice, neither from the pack nor from a repeated read", () => {
    const merged = withConnectedFolderToolEvidence(sent, [
      toolWindow("docs/a.md", 1, 10),
      toolWindow("docs/b.md", 1, 5),
      toolWindow("docs/b.md", 1, 5),
    ]);
    expect(merged.files.map((file) => file.excerpts.length)).toEqual([1, 1]);
  });

  it("leaves the retrieval's budget, usage and omissions as they were", () => {
    const merged = withConnectedFolderToolEvidence(sent, [toolWindow("docs/b.md", 1, 5)]);
    expect(merged.budget).toBe(sent.budget);
    expect(merged.usage).toBe(sent.usage);
    expect(merged.omitted).toBe(sent.omitted);
    expect(merged.stableId).toBe(sent.stableId);
    // The sent pack itself is not changed.
    expect(sent.files).toHaveLength(1);
  });

  it("carries a tool read on the assembled pack's identity when no pack was sent", () => {
    const assembled = pack([{ scopePath: "docs/a.md", excerpts: [excerpt("docs/a.md", 1, 10)] }]);
    const merged = answerEvidencePacks([], assembled, [toolWindow("docs/b.md", 1, 5)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.scope).toBe(assembled.scope);
    // Only what the model read is evidence: the assembled files were never sent.
    expect(merged[0]?.files.map((file) => file.scopePath)).toEqual(["docs/b.md"]);
    expect(unsupported("X [docs/a.md:1].", merged)).toEqual(["docs/a.md"]);
  });

  it("merges into the first pack and keeps every other pack", () => {
    const other = pack([{ scopePath: "x/y.md", excerpts: [excerpt("x/y.md", 1, 2)] }]);
    const merged = answerEvidencePacks([sent, other], sent, [toolWindow("docs/b.md", 1, 5)]);
    expect(merged[1]).toBe(other);
    expect(merged[0]?.files.map((file) => file.scopePath)).toEqual(["docs/a.md", "docs/b.md"]);
  });
});

describe("the retrieval's no-evidence notice on a folder tool turn", () => {
  const markers = [
    { kind: "no-evidence" },
    { kind: "low-confidence-selection" },
    { kind: "unsupported-citation" },
  ];
  const empty = pack([]);

  it("stays when the answer was given no lines at all", () => {
    expect(uncertaintyForSentEvidence(markers, [empty])).toBe(markers);
    expect(uncertaintyForSentEvidence(markers, [])).toBe(markers);
    expect(uncertaintyForSentEvidence(markers, undefined)).toBe(markers);
  });

  it("is dropped, and nothing else, once the model read lines through the tool", () => {
    const sent = answerEvidencePacks([empty], empty, [toolWindow("docs/b.md", 1, 5)]);
    expect(uncertaintyForSentEvidence(markers, sent)).toEqual([
      { kind: "low-confidence-selection" },
      { kind: "unsupported-citation" },
    ]);
  });

  it("stays for a tool read that returned no text", () => {
    const blank = toolWindow("docs/b.md", 1, 1);
    const sent = answerEvidencePacks([empty], empty, [
      { ...blank, excerpt: { ...blank.excerpt, content: "", contentBytes: 0 } },
    ]);
    expect(uncertaintyForSentEvidence(markers, sent)).toBe(markers);
  });
});
