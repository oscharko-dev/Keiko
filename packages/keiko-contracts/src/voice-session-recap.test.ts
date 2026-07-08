// Voice session recap contract tests (ADR-0109). Pinned behaviours:
//   AC1 — recap capability derives from the committed-transcript predicate (dormant for
//         "none" / "speech-output"; allowed for "speech-to-text" / "full-realtime").
//   AC3 — candidate lifecycle vocabulary: "proposed" first, terminal states delegated.
//   AC4 — the audit record is content-free by validation; a non-user-triggered audit record is
//         structurally invalid, making the "never automatic" invariant machine-checkable.
//   D8  — the module source carries no forbidden sensitive vocabulary (same scan posture as
//         voice-action-intent.ts).
// The module is pure; these tests read no clock and perform no IO beyond the source scan.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { VoiceProfile } from "./gateway.js";
import {
  isVoiceRecapCandidateStatus,
  isVoiceSessionRecapSchemaVersionSupported,
  validateVoiceSessionRecapAuditRecord,
  VOICE_RECAP_CANDIDATE_STATUSES,
  VOICE_SESSION_RECAP_SCHEMA_VERSION,
  voiceRecapAllowed,
  type VoiceSessionRecapAuditRecord,
} from "./voice-session-recap.js";

const FORBIDDEN_SUBSTRINGS = [
  "apikey",
  "secret",
  "password",
  "credential",
  "bearer",
  "baseurl",
  "endpoint",
  "authorization",
  "privatekey",
  "accesskey",
  "token",
  "systemprompt",
  "toolauthority",
  "grantedtools",
  "allowedtools",
  "canexecute",
] as const;

function validAuditRecord(
  overrides: Partial<Record<keyof VoiceSessionRecapAuditRecord, unknown>> = {},
): unknown {
  return {
    schemaVersion: VOICE_SESSION_RECAP_SCHEMA_VERSION,
    profile: "full-realtime",
    committedSegmentCount: 3,
    committedChars: 120,
    candidatesExtracted: 4,
    candidatesRejected: 1,
    candidatesProposed: 3,
    triggeredByUser: true,
    durationMs: 42,
    ...overrides,
  };
}

describe("voice-session-recap contract", () => {
  it("pins the schema version and rejects every other value", () => {
    expect(VOICE_SESSION_RECAP_SCHEMA_VERSION).toBe("1");
    expect(isVoiceSessionRecapSchemaVersionSupported("1")).toBe(true);
    for (const other of ["0", "2", 1, undefined, null, ""]) {
      expect(isVoiceSessionRecapSchemaVersionSupported(other)).toBe(false);
    }
  });

  it("derives recap capability from the committed-transcript predicate (AC1)", () => {
    const expectations: readonly [VoiceProfile, boolean][] = [
      ["none", false],
      ["speech-output", false],
      ["speech-to-text", true],
      ["full-realtime", true],
    ];
    for (const [profile, allowed] of expectations) {
      expect(voiceRecapAllowed(profile)).toBe(allowed);
    }
  });

  it("pins the candidate lifecycle vocabulary with 'proposed' first (AC3)", () => {
    expect(VOICE_RECAP_CANDIDATE_STATUSES[0]).toBe("proposed");
    expect(VOICE_RECAP_CANDIDATE_STATUSES).toEqual([
      "proposed",
      "accepted",
      "rejected",
      "forgotten",
    ]);
    for (const status of VOICE_RECAP_CANDIDATE_STATUSES) {
      expect(isVoiceRecapCandidateStatus(status)).toBe(true);
    }
    expect(isVoiceRecapCandidateStatus("archived")).toBe(false);
    expect(isVoiceRecapCandidateStatus(1)).toBe(false);
  });

  it("accepts a well-formed audit record", () => {
    expect(validateVoiceSessionRecapAuditRecord(validAuditRecord())).toEqual({ ok: true });
  });

  it("rejects malformed audit records with a precise reason", () => {
    const cases: readonly [unknown, string][] = [
      [null, "audit: must be an object"],
      [validAuditRecord({ schemaVersion: "2" }), "schemaVersion: unsupported"],
      [validAuditRecord({ profile: "loud" }), "profile: unknown voice profile"],
      [validAuditRecord({ committedChars: -1 }), "committedChars: must be a non-negative integer"],
      [
        validAuditRecord({ candidatesProposed: 1.5 }),
        "candidatesProposed: must be a non-negative integer",
      ],
      [validAuditRecord({ durationMs: "42" }), "durationMs: must be a non-negative integer"],
    ];
    for (const [value, reason] of cases) {
      expect(validateVoiceSessionRecapAuditRecord(value)).toEqual({ ok: false, reason });
    }
  });

  it("structurally rejects a non-user-triggered audit record (recap is never automatic)", () => {
    const result = validateVoiceSessionRecapAuditRecord(
      validAuditRecord({ triggeredByUser: false }),
    );
    expect(result.ok).toBe(false);
  });

  it("the module source contains no forbidden sensitive vocabulary (D8)", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./voice-session-recap.ts", import.meta.url)),
      "utf8",
    ).toLowerCase();
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      expect(source).not.toContain(forbidden);
    }
  });
});
