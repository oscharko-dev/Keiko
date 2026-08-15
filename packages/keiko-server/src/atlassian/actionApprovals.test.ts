// Hermetic tests for the bounded pending-approval registry (Issue #2244): injected clock (no
// wall-clock races), TTL eviction, capacity, and single-use consumption.

import { describe, expect, it } from "vitest";
import {
  ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS,
  isSafeAtlassianContentPreview,
  type AtlassianConnectorPendingApproval,
} from "@oscharko-dev/keiko-contracts";
import {
  ATLASSIAN_ACTION_APPROVAL_MAX_PENDING,
  ATLASSIAN_ACTION_APPROVAL_TTL_MS,
  AtlassianActionApprovalRegistry,
  contentPreviewFor,
  type AtlassianWriteActionInput,
  type PendingAtlassianActionEntry,
} from "./actionApprovals.js";

const T0 = 1_700_000_000_000;

function approval(approvalId: string, requestedAt = T0): AtlassianConnectorPendingApproval {
  return {
    schemaVersion: "1",
    approvalId,
    connectorId: "cred-abc",
    provider: "jira",
    actionType: "create-issue",
    actionClass: "connector-write",
    requiredScope: "issue-tracker.write",
    risk: "high",
    reviewReason: "deterministic-risk-approval-required",
    targetRef: "PROJ",
    correlationId: `corr-${approvalId}`,
    requestedAt,
    expiresAt: requestedAt + ATLASSIAN_ACTION_APPROVAL_TTL_MS,
  };
}

function entry(approvalId: string, requestedAt = T0): PendingAtlassianActionEntry {
  return {
    approval: approval(approvalId, requestedAt),
    authority: { runId: "run-1", envelopeDigest: "d".repeat(64), workspaceRoot: "/repo" },
    authRef: "atlassian-cred:AbCdEfGhIjKlMnOpQrStUv",
    payload: {
      kind: "write-action",
      action: {
        type: "create-issue",
        projectKey: "PROJ",
        issueTypeId: "1",
        summary: "held server-side only",
      },
    },
  };
}

describe("AtlassianActionApprovalRegistry", () => {
  it("stores, lists, and single-use-consumes entries", () => {
    const registry = new AtlassianActionApprovalRegistry(() => T0);
    expect(registry.create(entry("a1"))).toEqual({ ok: true });
    expect(registry.listPending().map((item) => item.approvalId)).toEqual(["a1"]);
    expect(registry.get("a1")?.approval.approvalId).toBe("a1");
    expect(registry.consume("a1")?.approval.approvalId).toBe("a1");
    expect(registry.consume("a1")).toBeUndefined();
    expect(registry.listPending()).toEqual([]);
  });

  it("evicts expired entries on every operation: an expired approval is unresolvable", () => {
    let now = T0;
    const registry = new AtlassianActionApprovalRegistry(() => now);
    registry.create(entry("a1"));
    now = T0 + ATLASSIAN_ACTION_APPROVAL_TTL_MS - 1;
    expect(registry.get("a1")).toBeDefined();
    now = T0 + ATLASSIAN_ACTION_APPROVAL_TTL_MS;
    expect(registry.get("a1")).toBeUndefined();
    expect(registry.consume("a1")).toBeUndefined();
    expect(registry.reject("a1")).toBeUndefined();
    expect(registry.listPending()).toEqual([]);
  });

  it("is bounded: refuses past capacity and frees capacity through expiry", () => {
    let now = T0;
    const registry = new AtlassianActionApprovalRegistry(() => now);
    for (let index = 0; index < ATLASSIAN_ACTION_APPROVAL_MAX_PENDING; index += 1) {
      expect(registry.create(entry(`a${String(index)}`)).ok).toBe(true);
    }
    expect(registry.create(entry("overflow"))).toEqual({
      ok: false,
      reason: "capacity-exhausted",
    });
    now = T0 + ATLASSIAN_ACTION_APPROVAL_TTL_MS + 1;
    expect(registry.create(entry("after-expiry", now)).ok).toBe(true);
  });

  it("reject removes the entry exactly like consume (never executable afterwards)", () => {
    const registry = new AtlassianActionApprovalRegistry(() => T0);
    registry.create(entry("a1"));
    expect(registry.reject("a1")?.approval.approvalId).toBe("a1");
    expect(registry.consume("a1")).toBeUndefined();
  });

  it("reset clears all state (test isolation seam)", () => {
    const registry = new AtlassianActionApprovalRegistry(() => T0);
    registry.create(entry("a1"));
    registry.reset();
    expect(registry.listPending()).toEqual([]);
  });
});

// KEIKO-0186: the pure extraction the pending-approval wire projection derives its bounded
// content preview from. Every write-action variant, the overlong-input and control-character
// axes the original finding calls out, and (P1 follow-up, Codex) the "sanitizes/truncates to
// nothing presentable" axis: zero-width-only, bidi-only, mixed, and combining-marks-only input.
describe("contentPreviewFor", () => {
  it("combines summary and descriptionText for create-issue", () => {
    const action: AtlassianWriteActionInput = {
      type: "create-issue",
      projectKey: "PROJ",
      summary: "Fix the flaky gate",
      descriptionText: "Fails on retries",
    };
    expect(contentPreviewFor(action)).toEqual({
      status: "available",
      text: "Fix the flaky gate\n\nFails on retries",
    });
  });

  it("uses summary alone for create-issue when descriptionText is absent", () => {
    const action: AtlassianWriteActionInput = {
      type: "create-issue",
      projectKey: "PROJ",
      summary: "Fix the flaky gate",
    };
    expect(contentPreviewFor(action)).toEqual({ status: "available", text: "Fix the flaky gate" });
  });

  it("combines summary and descriptionText for update-issue-fields when both are present", () => {
    const action: AtlassianWriteActionInput = {
      type: "update-issue-fields",
      issueKey: "PROJ-9",
      summary: "Sharper",
      descriptionText: "Clarified acceptance criteria",
    };
    expect(contentPreviewFor(action)).toEqual({
      status: "available",
      text: "Sharper\n\nClarified acceptance criteria",
    });
  });

  it("returns none for update-issue-fields when neither summary nor descriptionText is set", () => {
    const action: AtlassianWriteActionInput = {
      type: "update-issue-fields",
      issueKey: "PROJ-9",
      labels: ["urgent"],
      priorityName: "High",
    };
    expect(contentPreviewFor(action)).toEqual({ status: "none" });
  });

  it("always returns none for transition-issue (no text field exists)", () => {
    const action: AtlassianWriteActionInput = {
      type: "transition-issue",
      issueKey: "PROJ-9",
      transitionId: "31",
    };
    expect(contentPreviewFor(action)).toEqual({ status: "none" });
  });

  it("uses commentText for add-issue-comment and add-page-comment", () => {
    expect(
      contentPreviewFor({
        type: "add-issue-comment",
        issueKey: "PROJ-9",
        commentText: "Verified on staging",
      }),
    ).toEqual({ status: "available", text: "Verified on staging" });
    expect(
      contentPreviewFor({
        type: "add-page-comment",
        pageId: "123",
        commentText: "Looks right",
      }),
    ).toEqual({ status: "available", text: "Looks right" });
  });

  it("combines title and bodyText for create-page and update-page", () => {
    expect(
      contentPreviewFor({
        type: "create-page",
        spaceId: "777",
        title: "Runbook",
        bodyText: "Steps here",
      }),
    ).toEqual({ status: "available", text: "Runbook\n\nSteps here" });
    expect(
      contentPreviewFor({
        type: "update-page",
        pageId: "123",
        title: "Runbook",
        bodyText: "New body",
        currentVersion: 4,
      }),
    ).toEqual({ status: "available", text: "Runbook\n\nNew body" });
  });

  it("truncates to exactly ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS when the combined text is longer", () => {
    const summary = "S".repeat(200);
    const descriptionText = "D".repeat(200);
    const preview = contentPreviewFor({
      type: "create-issue",
      projectKey: "PROJ",
      summary,
      descriptionText,
    });
    expect(preview.status).toBe("available");
    if (preview.status !== "available") throw new Error("expected an available preview");
    expect(preview.text).toHaveLength(ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS);
    const combined = `${summary}\n\n${descriptionText}`;
    expect(preview.text).toBe(combined.slice(0, ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS));
  });

  it("strips a real control character (BELL, U+0007) before bounding, never surfacing it", () => {
    const hostileSummary = "visible" + String.fromCharCode(7) + "bell";
    expect(
      contentPreviewFor({ type: "create-issue", projectKey: "PROJ", summary: hostileSummary }),
    ).toEqual({ status: "available", text: "visiblebell" });
  });

  it("strips a bidi override character (RIGHT-TO-LEFT OVERRIDE, U+202E) before bounding, never surfacing it", () => {
    const hostileSummary = "visible" + String.fromCharCode(0x202e) + "evil";
    expect(
      contentPreviewFor({ type: "create-issue", projectKey: "PROJ", summary: hostileSummary }),
    ).toEqual({ status: "available", text: "visibleevil" });
  });

  it("strips a zero-width space (U+200B) before bounding, never surfacing it", () => {
    const hostileSummary = "visible" + String.fromCharCode(0x200b) + "zerowidth";
    expect(
      contentPreviewFor({ type: "create-issue", projectKey: "PROJ", summary: hostileSummary }),
    ).toEqual({ status: "available", text: "visiblezerowidth" });
  });

  it("preserves TAB/LF/CR (legitimate multi-line formatting) while stripping other control characters", () => {
    const preview = contentPreviewFor({
      type: "create-page",
      spaceId: "777",
      title: "Runbook",
      bodyText: "Step 1\tdo this\nStep 2\r\ndo that",
    });
    expect(preview).toEqual({
      status: "available",
      text: "Runbook\n\nStep 1\tdo this\nStep 2\r\ndo that",
    });
  });

  it("an oversized AND hostile payload is both stripped and truncated to the bound", () => {
    const hostile =
      String.fromCharCode(0x202e) +
      "A" +
      "x".repeat(ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS + 500);
    const preview = contentPreviewFor({
      type: "add-issue-comment",
      issueKey: "PROJ-9",
      commentText: hostile,
    });
    expect(preview.status).toBe("available");
    if (preview.status !== "available") throw new Error("expected an available preview");
    expect(preview.text).toHaveLength(ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS);
    expect(preview.text).toBe("A" + "x".repeat(ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS - 1));
  });

  // KEIKO-0186 P1 (Codex): "raw is non-empty" does not mean the SANITIZED, BOUNDED result is
  // presentable. Each case below must return "unavailable" -- never an empty (or otherwise
  // unpresentable) "available" text, which would show a reviewer what looks like a contentless
  // action while invisible content is actually written: exactly the failure this finding reports.

  it("an all-zero-width-space payload sanitizes to empty and is reported unavailable, not an empty preview", () => {
    const allZeroWidth = String.fromCharCode(0x200b).repeat(12);
    expect(
      contentPreviewFor({
        type: "add-issue-comment",
        issueKey: "PROJ-9",
        commentText: allZeroWidth,
      }),
    ).toEqual({ status: "unavailable" });
  });

  it("an all-bidi-override payload sanitizes to empty and is reported unavailable, not an empty preview", () => {
    const allBidi = String.fromCharCode(0x202e).repeat(12);
    expect(
      contentPreviewFor({ type: "create-issue", projectKey: "PROJ", summary: allBidi }),
    ).toEqual({
      status: "unavailable",
    });
  });

  it("a mixed bidi+zero-width payload that sanitizes to empty is reported unavailable", () => {
    const mixedInvisible =
      String.fromCharCode(0x202e) +
      String.fromCharCode(0x200b) +
      String.fromCharCode(0x202e) +
      String.fromCharCode(0x200b);
    expect(
      contentPreviewFor({ type: "add-page-comment", pageId: "123", commentText: mixedInvisible }),
    ).toEqual({ status: "unavailable" });
  });

  it("a payload that is entirely Unicode combining marks is reported unavailable even though it survives sanitization non-empty", () => {
    // Combining marks are neither C0/C1 controls nor in the bidi/zero-width block
    // stripUnsafeFormatChars removes, so this string is NON-EMPTY after sanitization -- and still
    // carries no base character for a reviewer to read: exactly as uninformative as empty.
    const allCombining = String.fromCharCode(0x301).repeat(10);
    expect(
      contentPreviewFor({
        type: "add-issue-comment",
        issueKey: "PROJ-9",
        commentText: allCombining,
      }),
    ).toEqual({ status: "unavailable" });
  });

  it("truncation can create an all-combining-marks result even when the untruncated text has a base character past the bound", () => {
    // The base character sits at index MAX (just past the truncation window), so the FIRST MAX
    // characters -- the ones that become the preview -- are combining marks only. Caught only
    // because presentability is checked AFTER truncation, not before (see contentPreviewFor).
    const combiningPrefix = String.fromCharCode(0x301).repeat(
      ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS,
    );
    const summary = combiningPrefix + "X";
    expect(summary.length).toBeGreaterThan(ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS);
    expect(contentPreviewFor({ type: "create-issue", projectKey: "PROJ", summary })).toEqual({
      status: "unavailable",
    });
  });

  // KEIKO-0186 P2 (Codex): the P1 predicate (^\p{M}+$) is anchored end-to-end, so any OTHER
  // character defeated it -- including whitespace. A whitespace-only payload, or whitespace next
  // to the P1 shapes, rendered as an apparently blank-but-"available" preview: the same failure
  // mode as P1, reached through a different input. Each case below must be "unavailable".

  it("a whitespace-only payload (space, TAB, LF, and a mix) is reported unavailable, not a blank-looking preview", () => {
    const space = " ";
    const tab = String.fromCharCode(9);
    const lf = String.fromCharCode(10);
    for (const whitespace of [space, tab, lf, space + tab + lf + space]) {
      expect(
        contentPreviewFor({
          type: "add-issue-comment",
          issueKey: "PROJ-9",
          commentText: whitespace,
        }),
      ).toEqual({ status: "unavailable" });
    }
  });

  it("whitespace next to a combining mark, in either order, is reported unavailable", () => {
    const spaceThenMark = " " + String.fromCharCode(0x301);
    const markThenSpace = String.fromCharCode(0x301) + " ";
    expect(
      contentPreviewFor({ type: "create-issue", projectKey: "PROJ", summary: spaceThenMark }),
    ).toEqual({ status: "unavailable" });
    expect(
      contentPreviewFor({ type: "create-issue", projectKey: "PROJ", summary: markThenSpace }),
    ).toEqual({ status: "unavailable" });
  });

  it("whitespace next to a zero-width character sanitizes to whitespace-only and is reported unavailable", () => {
    const spaceThenZeroWidth = " " + String.fromCharCode(0x200b);
    expect(
      contentPreviewFor({
        type: "add-page-comment",
        pageId: "123",
        commentText: spaceThenZeroWidth,
      }),
    ).toEqual({ status: "unavailable" });
  });

  it("truncation can create a whitespace-only tail even when the untruncated text has a base character past the bound", () => {
    const spacePrefix = " ".repeat(ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS);
    const summary = spacePrefix + "X";
    expect(summary.length).toBeGreaterThan(ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS);
    expect(contentPreviewFor({ type: "create-issue", projectKey: "PROJ", summary })).toEqual({
      status: "unavailable",
    });
  });

  it("truncation can create a whitespace-plus-combining-mark tail even when the untruncated text has a base character past the bound", () => {
    // Same shape as the all-combining-marks truncation case above, but the truncation window is
    // alternating space + combining-mark pairs instead of combining marks alone.
    const pairs = (" " + String.fromCharCode(0x301)).repeat(
      Math.ceil(ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS / 2),
    );
    const summary = pairs.slice(0, ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS) + "X";
    expect(summary.length).toBeGreaterThan(ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS);
    expect(contentPreviewFor({ type: "create-issue", projectKey: "PROJ", summary })).toEqual({
      status: "unavailable",
    });
  });

  // No separate "truncation-induced whitespace-plus-zero-width" case: zero-width characters are
  // removed by stripUnsafeFormatChars during sanitization, which runs BEFORE truncation, so they
  // can never be part of what survives INTO a truncation window -- only whitespace and combining
  // marks are both preserved by sanitization and classified as non-base-character, so only they
  // can populate a truncation-surviving tail. A raw payload padded with zero-width characters
  // simply sanitizes down to something short enough that truncation never triggers.

  // KEIKO-0186 P3 (Codex): U+3164 HANGUL FILLER renders as nothing but belongs to Unicode general
  // category Lo (a letter), so stripUnsafeFormatChars never touches it (it is not bidi/zero-width/
  // control) and it survives sanitization exactly like whitespace and combining marks do -- which
  // also means, like them, it CAN populate a truncation-surviving tail.

  it("an all-HANGUL-FILLER payload survives sanitization non-empty and is reported unavailable", () => {
    const hangulFiller = String.fromCodePoint(0x3164).repeat(5);
    expect(
      contentPreviewFor({
        type: "add-issue-comment",
        issueKey: "PROJ-9",
        commentText: hangulFiller,
      }),
    ).toEqual({ status: "unavailable" });
  });

  it("a bare variation selector payload is reported unavailable", () => {
    const variationSelector16 = String.fromCodePoint(0xfe0f);
    expect(
      contentPreviewFor({
        type: "add-page-comment",
        pageId: "123",
        commentText: variationSelector16,
      }),
    ).toEqual({ status: "unavailable" });
  });

  it("truncation can create an all-HANGUL-FILLER tail even when the untruncated text has a base character past the bound", () => {
    const fillerPrefix = String.fromCodePoint(0x3164).repeat(
      ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS,
    );
    const summary = fillerPrefix + "X";
    expect(summary.length).toBeGreaterThan(ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS);
    expect(contentPreviewFor({ type: "create-issue", projectKey: "PROJ", summary })).toEqual({
      status: "unavailable",
    });
  });

  // KEIKO-0186 P4 (Codex): U+2800 BRAILLE PATTERN BLANK is deliberately blank by design, yet
  // Unicode general category So (a symbol) -- it matched none of \s, \p{M}, or
  // Default_Ignorable_Code_Point, defeating every prior layer. The predicate is now an allowlist
  // (Letter, Number, Punctuation); a symbol is never in that set regardless of whether anyone
  // ever named it specifically, and it survives sanitization exactly like whitespace/combining
  // marks/HANGUL FILLER do, so it can also populate a truncation-surviving tail.

  it("an all-BRAILLE-PATTERN-BLANK payload survives sanitization non-empty and is reported unavailable", () => {
    const braillePatternBlank = String.fromCodePoint(0x2800).repeat(5);
    expect(
      contentPreviewFor({
        type: "add-issue-comment",
        issueKey: "PROJ-9",
        commentText: braillePatternBlank,
      }),
    ).toEqual({ status: "unavailable" });
  });

  it("truncation can create an all-BRAILLE-PATTERN-BLANK tail even when the untruncated text has a base character past the bound", () => {
    const braillePrefix = String.fromCodePoint(0x2800).repeat(
      ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS,
    );
    const summary = braillePrefix + "X";
    expect(summary.length).toBeGreaterThan(ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS);
    expect(contentPreviewFor({ type: "create-issue", projectKey: "PROJ", summary })).toEqual({
      status: "unavailable",
    });
  });

  // P4's allowlist excludes \p{S} (Symbol, including emoji) entirely -- a deliberate, documented
  // cost (see isAtlassianContentPreviewUnpresentable's definition), not an oversight. \p{L}
  // already covers CJK ideographs and other non-Latin scripts, so the exclusion is narrower than
  // "non-Latin text": it targets symbols and emoji specifically.

  it("an emoji-only payload is reported unavailable", () => {
    const grinningFace = String.fromCodePoint(0x1f600);
    expect(
      contentPreviewFor({ type: "add-page-comment", pageId: "123", commentText: grinningFace }),
    ).toEqual({ status: "unavailable" });
  });

  it("a CJK-only payload is reported available: \\p{L} covers CJK ideographs, so this is unaffected by the \\p{S} exclusion", () => {
    const done = "已完成"; // Chinese: "done"
    expect(
      contentPreviewFor({ type: "add-issue-comment", issueKey: "PROJ-9", commentText: done }),
    ).toEqual({ status: "available", text: done });
  });

  // KEIKO-0186 P5 (Codex): U+13441 EGYPTIAN HIEROGLYPH FULL BLANK and U+13442 HALF BLANK are
  // Unicode general category Lo (letters) that render blank -- a fifth input class defeating
  // character-property classification. Closed here (KNOWN_BLANK_LETTER_PATTERN), but the
  // predicate is now a heuristic backed by the character-count signal ConnectorApprovalsPanel
  // renders alongside every available preview, not the sole defence -- see
  // isAtlassianContentPreviewUnpresentable's definition.
  it("an all-EGYPTIAN-HIEROGLYPH-BLANK payload is reported unavailable", () => {
    const fullBlank = String.fromCodePoint(0x13441);
    const halfBlank = String.fromCodePoint(0x13442);
    expect(
      contentPreviewFor({
        type: "add-issue-comment",
        issueKey: "PROJ-9",
        commentText: fullBlank + halfBlank,
      }),
    ).toEqual({ status: "unavailable" });
  });

  it("agrees with isSafeAtlassianContentPreview in every case: an emitted 'available' text always passes the contract predicate", () => {
    const cases: readonly AtlassianWriteActionInput[] = [
      { type: "create-issue", projectKey: "PROJ", summary: "Fix the flaky gate" },
      {
        type: "add-issue-comment",
        issueKey: "PROJ-9",
        commentText: "visible" + String.fromCharCode(0x200b) + "text",
      },
      {
        type: "create-page",
        spaceId: "777",
        title: "Runbook",
        bodyText: "S".repeat(ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS + 50),
      },
    ];
    for (const action of cases) {
      const preview = contentPreviewFor(action);
      expect(preview.status).toBe("available");
      if (preview.status !== "available") continue;
      expect(isSafeAtlassianContentPreview(preview.text)).toBe(true);
    }
  });

  it("agrees with isSafeAtlassianContentPreview in every unavailable case: empty, combining-marks-only, whitespace-only, whitespace-plus-combining, default-ignorable-only, symbol/emoji-only, and blank-letter-only strings all fail the contract predicate too", () => {
    expect(isSafeAtlassianContentPreview("")).toBe(false);
    expect(isSafeAtlassianContentPreview(String.fromCharCode(0x301).repeat(5))).toBe(false);
    expect(isSafeAtlassianContentPreview(" ")).toBe(false);
    expect(isSafeAtlassianContentPreview(" " + String.fromCharCode(0x301))).toBe(false);
    expect(isSafeAtlassianContentPreview(String.fromCodePoint(0x3164))).toBe(false);
    expect(isSafeAtlassianContentPreview(String.fromCodePoint(0xfe0f))).toBe(false);
    expect(isSafeAtlassianContentPreview(String.fromCodePoint(0x2800))).toBe(false);
    expect(isSafeAtlassianContentPreview(String.fromCodePoint(0x1f600))).toBe(false);
    expect(isSafeAtlassianContentPreview(String.fromCodePoint(0x13441))).toBe(false);
    expect(isSafeAtlassianContentPreview(String.fromCodePoint(0x13442))).toBe(false);
  });
});
