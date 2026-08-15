import { describe, expect, it } from "vitest";

import {
  CODING_WORKBENCH_ACTION_CLASSES,
  CODING_WORKBENCH_MODEL_SOURCES,
  CODING_WORKBENCH_MODES,
  CODING_WORKBENCH_SUPERVISED_ACTION_KINDS,
} from "./coding-workbench.js";
import { CODING_WORKBENCH_CODEX_AUTH_METHODS } from "./coding-workbench-codex-auth.js";
import {
  APPROVED_EVIDENCE_LITERALS,
  APPROVED_EVIDENCE_SEGMENTS,
  hasDisallowedEvidenceContent,
  isCodingWorkbenchEvidenceSafeText,
  redactCodingWorkbenchEvidenceText,
  validateCodingWorkbenchEvidenceRecord,
} from "./coding-workbench-evidence.js";

function evidenceRecord(occurredAt: string): Record<string, unknown> {
  return {
    schemaVersion: "1",
    recordId: "event-runtime-1",
    runId: "run-runtime-1",
    occurredAt,
    kind: "run",
    effectiveMode: "supervised-coding",
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
  };
}

describe("coding workbench evidence redaction", () => {
  it("keeps auxiliary evidence content-free", () => {
    expect(isCodingWorkbenchEvidenceSafeText("event-skill-1")).toBe(true);
    expect(
      redactCodingWorkbenchEvidenceText("https://docs.example.org/private?q=secret"),
    ).not.toContain("secret");
  });

  it.each(["2026-07-31T12:00:00Z", "2026-07-31T12:00:00.123Z"])(
    "accepts a canonical UTC evidence instant: %s",
    (occurredAt) => {
      expect(validateCodingWorkbenchEvidenceRecord(evidenceRecord(occurredAt)).ok).toBe(true);
    },
  );

  it.each([
    "",
    "2026-04-31T00:00:00Z",
    "2026-02-29T00:00:00Z",
    "2026-07-31 12:00:00 GMT+0000 Z",
    "2026-07-31T12:00:00+00:00",
    "2026-07-31T12:00:00.1Z",
    "2026-07-31T12:00:00.000z",
    "2026-07-31T12:00:00Z\u0000suffix",
  ])("rejects a normalized or non-canonical evidence instant: %s", (occurredAt) => {
    expect(validateCodingWorkbenchEvidenceRecord(evidenceRecord(occurredAt)).ok).toBe(false);
  });
});

// KEIKO-0376: the old APPROVED_EVIDENCE_TOKENS Set mixed separator-free words (consulted per
// split segment) with 57 hyphenated/dotted whole strings the segment-split lookup could never
// reach, so every composite literal was dead code and any composite missing even one constituent
// segment word was wrongly rejected despite appearing allow-listed verbatim.
//
// Two content-check exceptions are documented and asserted explicitly rather than skipped:
// "openai-api-key-through-gateway" (CodingWorkbenchModelSource) and "codex-access-token"
// (CodingWorkbenchCodexAuthMethod) each contain a bare `api-key`/`token` word that
// hasDisallowedEvidenceContent legitimately matches. That check runs unconditionally in
// isCodingWorkbenchEvidenceSafeText regardless of allowlist membership -- an approved shape must
// never bypass it -- and neither literal is ever actually routed through this guard by a real
// producer: `modelSource` and `authMethod` are each validated by their own dedicated closed-enum
// membership check instead (coding-workbench-evidence.ts's validateEvidenceMetadataFields;
// coding-workbench-codex-auth.ts's isOneOf(..., CODING_WORKBENCH_CODEX_AUTH_METHODS) call sites).
describe("evidence-safe-text allowlist covers every canonical enum literal (KEIKO-0376)", () => {
  const CONTENT_CHECK_EXCEPTIONS = new Set<string>([
    "openai-api-key-through-gateway",
    "codex-access-token",
  ]);

  it("accepts the governed-assist mode literal (mustFailBeforeFix regression pin)", () => {
    // Before the fix: "governed-assist".split(/[/._-]/u) -> ["governed", "assist"]; "assist" was
    // never an approved segment, so the label was rejected despite appearing verbatim in the old
    // allowlist and being a real CodingWorkbenchMode value (coding-workbench.ts:5,8).
    expect(isCodingWorkbenchEvidenceSafeText("governed-assist")).toBe(true);
  });

  it.each(CODING_WORKBENCH_MODES)("CodingWorkbenchMode %s is evidence-safe text", (mode) => {
    expect(isCodingWorkbenchEvidenceSafeText(mode)).toBe(true);
  });

  it.each(CODING_WORKBENCH_MODEL_SOURCES)(
    "CodingWorkbenchModelSource %s is evidence-safe text unless it is a documented content-check exception",
    (source) => {
      expect(isCodingWorkbenchEvidenceSafeText(source)).toBe(!CONTENT_CHECK_EXCEPTIONS.has(source));
    },
  );

  it.each(CODING_WORKBENCH_ACTION_CLASSES)(
    "CodingWorkbenchActionClass %s is evidence-safe text",
    (actionClass) => {
      expect(isCodingWorkbenchEvidenceSafeText(actionClass)).toBe(true);
    },
  );

  it.each(CODING_WORKBENCH_SUPERVISED_ACTION_KINDS)(
    "CodingWorkbenchSupervisedActionKind %s is evidence-safe text",
    (kind) => {
      expect(isCodingWorkbenchEvidenceSafeText(kind)).toBe(true);
    },
  );

  it.each(CODING_WORKBENCH_CODEX_AUTH_METHODS)(
    "CodingWorkbenchCodexAuthMethod %s is evidence-safe text unless it is a documented content-check exception",
    (method) => {
      expect(isCodingWorkbenchEvidenceSafeText(method)).toBe(!CONTENT_CHECK_EXCEPTIONS.has(method));
    },
  );

  it("never lets an approved shape bypass the content check, for either documented exception", () => {
    for (const value of CONTENT_CHECK_EXCEPTIONS) {
      expect(hasDisallowedEvidenceContent(value)).toBe(true);
      expect(isCodingWorkbenchEvidenceSafeText(value)).toBe(false);
    }
  });

  it("contains no poison entry: every allowlisted segment and literal passes the content check", () => {
    // Machine-checked version of the invariant the whole fix depends on: allowlist membership
    // (shape) and hasDisallowedEvidenceContent (content) are independent, and neither Set may
    // contain an entry that could never actually pass isCodingWorkbenchEvidenceSafeText.
    for (const segment of APPROVED_EVIDENCE_SEGMENTS) {
      expect(hasDisallowedEvidenceContent(segment)).toBe(false);
    }
    for (const literal of APPROVED_EVIDENCE_LITERALS) {
      expect(hasDisallowedEvidenceContent(literal)).toBe(false);
    }
  });

  it("has no unreachable literal: every entry of APPROVED_EVIDENCE_LITERALS is itself evidence-safe text", () => {
    for (const literal of APPROVED_EVIDENCE_LITERALS) {
      expect(isCodingWorkbenchEvidenceSafeText(literal)).toBe(true);
    }
  });

  // codingRuntimeManager.ts's supervisedEvidenceContext builds
  // `coding-runtime-${runId}-${actionKind}` as the evidence record's recordId for every supervised
  // action except file-edit/verification-command; it is validated by this same guard via
  // validateCodingWorkbenchEvidenceRecord and THROWS on rejection (supervisedCodingPolicy.ts). The
  // embedded run id makes this string dynamic, so it can only ever pass via segment decomposition,
  // never the literal fast-path -- this is a fixture derived from the production template, not a
  // restated formula, and it is what mustFailBeforeFix would have caught for "pull-request" and
  // "system-mutation" had the audit traced this call site.
  it.each(CODING_WORKBENCH_SUPERVISED_ACTION_KINDS)(
    "the real coding-runtime recordId template stays evidence-safe text for actionKind %s",
    (actionKind) => {
      expect(isCodingWorkbenchEvidenceSafeText(`coding-runtime-run-1988-${actionKind}`)).toBe(true);
    },
  );
});
