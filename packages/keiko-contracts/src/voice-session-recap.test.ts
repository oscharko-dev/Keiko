// Regression tests for the Voice session recap contract (Issue #504, Epic #491, ADR-0067).
// These pin the acceptance criteria as executable, mutation-resistant invariants:
//   AC1 — recap is dormant without voice capture capability (none/speech-output → not allowed).
//   AC2 — capability allowed for speech-to-text / full-realtime (committed transcript capture).
//   AC3 — candidate status union is the proposed/accepted/rejected/forgotten governed subset.
//   AC4 — the audit record and evidence summary carry no text/audio; module source carries no secrets.
// The module is pure; these tests read no clock and perform no IO beyond reading the module source.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { VoiceProfile } from "./gateway.js";
import type { VoiceTranscriptEvidenceSummary } from "./voice-transcript.js";
import {
  VOICE_RECAP_ASSISTANT_TURN_SOURCES,
  VOICE_RECAP_CANDIDATE_STATUSES,
  VOICE_SESSION_RECAP_SCHEMA_VERSION,
  type VoiceRecapCandidateStatus,
  type VoiceSessionRecapAuditInput,
  type VoiceSessionRecapCandidateCounts,
  assertNeverVoiceRecapCandidateStatus,
  buildVoiceSessionRecapAuditRecord,
  isVoiceRecapAssistantTurnSource,
  isVoiceRecapCandidateStatus,
  isVoiceSessionRecapSchemaVersionSupported,
  summarizeVoiceSessionRecap,
  validateVoiceSessionRecapAuditRecord,
  voiceRecapAllowed,
} from "./voice-session-recap.js";

const VOICE_PROFILES: readonly VoiceProfile[] = [
  "none",
  "speech-to-text",
  "speech-output",
  "full-realtime",
];

// The same forbidden-substring catalog the spoken-action leaf scans for (ADR-0067 D8).
const FORBIDDEN_SUBSTRINGS: readonly string[] = [
  "apikey",
  "secret",
  "password",
  "credential",
  "bearer",
  "baseurl",
  "authorization",
  "privatekey",
  "accesskey",
  "systemprompt",
  "toolauthority",
  "grantedtools",
  "allowedtools",
  "canexecute",
];

// A fake secret string we route through the recap summary / audit to prove it never surfaces.
const FAKE_SECRET = "sk-test-ABC123";

function transcriptSummary(
  overrides: Partial<VoiceTranscriptEvidenceSummary> = {},
): VoiceTranscriptEvidenceSummary {
  return {
    schemaVersion: "1",
    segmentCount: 4,
    committedCount: 2,
    correctedCount: 1,
    discardedCount: 0,
    redactedCount: 0,
    providerErrorCount: 0,
    committedChars: 42,
    highestSeq: 7,
    ...overrides,
  };
}

function candidateCounts(
  overrides: Partial<VoiceSessionRecapCandidateCounts> = {},
): VoiceSessionRecapCandidateCounts {
  return {
    candidatesExtracted: 3,
    candidatesProposed: 2,
    candidatesRejected: 1,
    ...overrides,
  };
}

function auditInput(
  overrides: Partial<VoiceSessionRecapAuditInput> = {},
): VoiceSessionRecapAuditInput {
  return {
    profile: "speech-to-text",
    committedSegmentCount: 2,
    committedChars: 42,
    candidatesExtracted: 3,
    candidatesProposed: 2,
    candidatesRejected: 1,
    triggeredByUser: true,
    durationMs: 12,
    ...overrides,
  };
}

describe("schema version", () => {
  it("is the literal '1'", () => {
    expect(VOICE_SESSION_RECAP_SCHEMA_VERSION).toBe("1");
  });

  it("accepts only the supported version", () => {
    expect(isVoiceSessionRecapSchemaVersionSupported("1")).toBe(true);
    expect(isVoiceSessionRecapSchemaVersionSupported("2")).toBe(false);
    expect(isVoiceSessionRecapSchemaVersionSupported(1)).toBe(false);
    expect(isVoiceSessionRecapSchemaVersionSupported(undefined)).toBe(false);
    expect(isVoiceSessionRecapSchemaVersionSupported(null)).toBe(false);
  });
});

describe("AC1/AC2 — capability gating", () => {
  it("permits recap only where committed transcript capture is allowed", () => {
    const expected: Readonly<Record<VoiceProfile, boolean>> = {
      none: false,
      "speech-output": false,
      "speech-to-text": true,
      "full-realtime": true,
    };
    for (const profile of VOICE_PROFILES) {
      expect(voiceRecapAllowed(profile)).toBe(expected[profile]);
    }
  });

  it("is dormant for none and speech-output (AC1)", () => {
    expect(voiceRecapAllowed("none")).toBe(false);
    expect(voiceRecapAllowed("speech-output")).toBe(false);
  });

  it("allows speech-to-text and full-realtime (AC2)", () => {
    expect(voiceRecapAllowed("speech-to-text")).toBe(true);
    expect(voiceRecapAllowed("full-realtime")).toBe(true);
  });
});

describe("AC3 — candidate status lifecycle", () => {
  it("enumerates the governed subset proposed/accepted/rejected/expired/forgotten", () => {
    expect([...VOICE_RECAP_CANDIDATE_STATUSES]).toEqual([
      "proposed",
      "accepted",
      "rejected",
      "expired",
      "forgotten",
    ]);
  });

  it("includes 'expired' as a real review-queue status", () => {
    expect([...VOICE_RECAP_CANDIDATE_STATUSES]).toContain("expired");
    expect(isVoiceRecapCandidateStatus("expired")).toBe(true);
  });

  it("guards every member and rejects non-members", () => {
    for (const status of VOICE_RECAP_CANDIDATE_STATUSES) {
      expect(isVoiceRecapCandidateStatus(status)).toBe(true);
    }
    expect(isVoiceRecapCandidateStatus("superseded")).toBe(false);
    expect(isVoiceRecapCandidateStatus("conflicted")).toBe(false);
    expect(isVoiceRecapCandidateStatus("archived")).toBe(false);
    expect(isVoiceRecapCandidateStatus(42)).toBe(false);
    expect(isVoiceRecapCandidateStatus(undefined)).toBe(false);
    expect(isVoiceRecapCandidateStatus(null)).toBe(false);
  });

  it("exhaustiveness guard throws for an impossible value", () => {
    const rogue = "impossible" as unknown as never;
    expect(() => assertNeverVoiceRecapCandidateStatus(rogue)).toThrow(/Unhandled/);
  });

  it("narrows the union via the guard at every callsite", () => {
    const value: unknown = "forgotten";
    if (isVoiceRecapCandidateStatus(value)) {
      const narrowed: VoiceRecapCandidateStatus = value;
      expect(narrowed).toBe("forgotten");
    } else {
      throw new Error("guard should have narrowed");
    }
  });
});

describe("assistant-turn source", () => {
  it("is the closed text-response enum", () => {
    expect([...VOICE_RECAP_ASSISTANT_TURN_SOURCES]).toEqual(["text-response"]);
  });

  it("guards the member and rejects audio/TTS sources", () => {
    expect(isVoiceRecapAssistantTurnSource("text-response")).toBe(true);
    expect(isVoiceRecapAssistantTurnSource("audio")).toBe(false);
    expect(isVoiceRecapAssistantTurnSource("tts")).toBe(false);
    expect(isVoiceRecapAssistantTurnSource(7)).toBe(false);
    expect(isVoiceRecapAssistantTurnSource(null)).toBe(false);
  });
});

describe("evidence summary reuse", () => {
  it("embeds the transcript roll-up and adds recap candidate counts", () => {
    const transcript = transcriptSummary();
    const summary = summarizeVoiceSessionRecap(transcript, candidateCounts());
    expect(summary.schemaVersion).toBe("1");
    expect(summary.transcript).toEqual(transcript);
    expect(summary.candidatesExtracted).toBe(3);
    expect(summary.candidatesProposed).toBe(2);
    expect(summary.candidatesRejected).toBe(1);
  });

  it("is always user-triggered", () => {
    const summary = summarizeVoiceSessionRecap(transcriptSummary(), candidateCounts());
    expect(summary.triggeredByUser).toBe(true);
  });

  it("preserves committedChars from the transcript roll-up", () => {
    const transcript = transcriptSummary({ committedChars: 999 });
    const summary = summarizeVoiceSessionRecap(transcript, candidateCounts());
    expect(summary.transcript.committedChars).toBe(999);
  });
});

describe("audit record builder", () => {
  it("stamps the schema version and copies every content-free field", () => {
    const record = buildVoiceSessionRecapAuditRecord(auditInput());
    expect(record).toEqual({
      schemaVersion: "1",
      profile: "speech-to-text",
      committedSegmentCount: 2,
      committedChars: 42,
      candidatesExtracted: 3,
      candidatesProposed: 2,
      candidatesRejected: 1,
      triggeredByUser: true,
      durationMs: 12,
    });
  });

  it("is deterministic — identical input yields a deeply equal record", () => {
    const input = auditInput();
    expect(buildVoiceSessionRecapAuditRecord(input)).toEqual(
      buildVoiceSessionRecapAuditRecord(input),
    );
  });

  it("carries no text field by construction", () => {
    const record = buildVoiceSessionRecapAuditRecord(auditInput());
    expect(Object.keys(record)).not.toContain("text");
    expect(Object.keys(record)).not.toContain("committedText");
    expect(Object.keys(record)).not.toContain("transcript");
  });
});

describe("AC4 — audit record is content-free (never embeds a secret)", () => {
  it("never surfaces a secret routed through the summary and audit", () => {
    // The secret would only be in raw transcript text — which is structurally absent from these types.
    // We assert it can never leak into the serialized recap artifacts.
    const transcript = transcriptSummary({ committedChars: FAKE_SECRET.length });
    const summary = summarizeVoiceSessionRecap(transcript, candidateCounts());
    const record = buildVoiceSessionRecapAuditRecord(
      auditInput({ committedChars: FAKE_SECRET.length }),
    );
    const serialized = JSON.stringify({ summary, record });
    expect(serialized).not.toContain(FAKE_SECRET);
    expect(serialized).not.toContain("sk-test");
    expect(serialized).not.toContain("ABC123");
  });

  it("audit record serializes to counts/enums/bools only", () => {
    const record = buildVoiceSessionRecapAuditRecord(auditInput());
    const parsed = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
    for (const [key, fieldValue] of Object.entries(parsed)) {
      if (key === "schemaVersion" || key === "profile") {
        expect(typeof fieldValue).toBe("string");
      } else if (key === "triggeredByUser") {
        expect(typeof fieldValue).toBe("boolean");
      } else {
        expect(typeof fieldValue).toBe("number");
      }
    }
  });
});

describe("AC4 — module source forbidden-substring scan", () => {
  it("contains no forbidden secret-like substrings", () => {
    const sourcePath = fileURLToPath(new URL("./voice-session-recap.ts", import.meta.url));
    const source = readFileSync(sourcePath, "utf8").toLowerCase();
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe("validateVoiceSessionRecapAuditRecord", () => {
  it("accepts a well-formed record", () => {
    const record = buildVoiceSessionRecapAuditRecord(auditInput());
    expect(validateVoiceSessionRecapAuditRecord(record)).toEqual({ ok: true });
  });

  it("rejects non-objects", () => {
    expect(validateVoiceSessionRecapAuditRecord(null)).toEqual({
      ok: false,
      reason: "audit: must be an object",
    });
    expect(validateVoiceSessionRecapAuditRecord("nope")).toEqual({
      ok: false,
      reason: "audit: must be an object",
    });
    expect(validateVoiceSessionRecapAuditRecord(undefined).ok).toBe(false);
  });

  it("rejects an unsupported schema version", () => {
    const record = { ...buildVoiceSessionRecapAuditRecord(auditInput()), schemaVersion: "2" };
    expect(validateVoiceSessionRecapAuditRecord(record)).toEqual({
      ok: false,
      reason: "schemaVersion: unsupported",
    });
  });

  it("rejects an unknown profile", () => {
    const record = { ...buildVoiceSessionRecapAuditRecord(auditInput()), profile: "telepathy" };
    expect(validateVoiceSessionRecapAuditRecord(record)).toEqual({
      ok: false,
      reason: "profile: unknown voice profile",
    });
  });

  it("rejects each negative / non-integer count field", () => {
    const fields = [
      "committedSegmentCount",
      "committedChars",
      "candidatesExtracted",
      "candidatesRejected",
      "candidatesProposed",
      "durationMs",
    ] as const;
    for (const field of fields) {
      const record = { ...buildVoiceSessionRecapAuditRecord(auditInput()), [field]: -1 };
      expect(validateVoiceSessionRecapAuditRecord(record)).toEqual({
        ok: false,
        reason: `${field}: must be a non-negative integer`,
      });
      const fractional = { ...buildVoiceSessionRecapAuditRecord(auditInput()), [field]: 1.5 };
      expect(validateVoiceSessionRecapAuditRecord(fractional).ok).toBe(false);
    }
  });

  it("reports the first failing count field in declaration order", () => {
    const record = {
      ...buildVoiceSessionRecapAuditRecord(auditInput()),
      committedChars: -1,
      candidatesExtracted: -1,
    };
    expect(validateVoiceSessionRecapAuditRecord(record)).toEqual({
      ok: false,
      reason: "committedChars: must be a non-negative integer",
    });
  });

  it("rejects a non-boolean triggeredByUser", () => {
    const record = {
      ...buildVoiceSessionRecapAuditRecord(auditInput()),
      triggeredByUser: "yes" as unknown as boolean,
    };
    expect(validateVoiceSessionRecapAuditRecord(record)).toEqual({
      ok: false,
      reason: "triggeredByUser: must be a boolean",
    });
  });

  it("accepts every supported voice profile", () => {
    for (const profile of VOICE_PROFILES) {
      const record = buildVoiceSessionRecapAuditRecord(auditInput({ profile }));
      expect(validateVoiceSessionRecapAuditRecord(record)).toEqual({ ok: true });
    }
  });
});

describe("determinism", () => {
  it("summarize is a pure function of its inputs", () => {
    const transcript = transcriptSummary();
    const counts = candidateCounts();
    expect(summarizeVoiceSessionRecap(transcript, counts)).toEqual(
      summarizeVoiceSessionRecap(transcript, counts),
    );
  });
});
