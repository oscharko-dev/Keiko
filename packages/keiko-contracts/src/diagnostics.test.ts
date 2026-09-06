import { describe, expect, it } from "vitest";

import {
  CLIENT_DIAGNOSTIC_KINDS,
  CLIENT_DIAGNOSTIC_MESSAGE_MAX_LENGTH,
  CLIENT_DIAGNOSTIC_READY_STATES,
  isClientDiagnosticIngestRequest,
  isClientDiagnosticKind,
} from "./diagnostics.js";

function validRequest(): Record<string, unknown> {
  return {
    message: "boundary caught TypeError",
    clientTs: "2026-08-21T10:00:00.000Z",
  };
}

describe("isClientDiagnosticIngestRequest", () => {
  it("accepts the minimal required shape", () => {
    expect(isClientDiagnosticIngestRequest(validRequest())).toBe(true);
  });

  it("accepts every optional field populated with an in-range value", () => {
    for (const readyState of CLIENT_DIAGNOSTIC_READY_STATES) {
      for (const kind of CLIENT_DIAGNOSTIC_KINDS) {
        expect(
          isClientDiagnosticIngestRequest({
            ...validRequest(),
            readyState,
            correlationId: "abcdefgh",
            kind,
          }),
        ).toBe(true);
      }
    }
  });

  it("rejects a non-object value", () => {
    expect(isClientDiagnosticIngestRequest(null)).toBe(false);
    expect(isClientDiagnosticIngestRequest(undefined)).toBe(false);
    expect(isClientDiagnosticIngestRequest("a string")).toBe(false);
    expect(isClientDiagnosticIngestRequest(["array"])).toBe(false);
  });

  it("rejects a missing or non-string message", () => {
    expect(isClientDiagnosticIngestRequest({ clientTs: validRequest().clientTs })).toBe(false);
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), message: 42 })).toBe(false);
  });

  it("rejects an empty message", () => {
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), message: "" })).toBe(false);
  });

  it(`rejects a message over ${String(CLIENT_DIAGNOSTIC_MESSAGE_MAX_LENGTH)} characters`, () => {
    const tooLong = "a".repeat(CLIENT_DIAGNOSTIC_MESSAGE_MAX_LENGTH + 1);
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), message: tooLong })).toBe(false);
  });

  it(`accepts a message at exactly ${String(CLIENT_DIAGNOSTIC_MESSAGE_MAX_LENGTH)} characters`, () => {
    const atLimit = "a".repeat(CLIENT_DIAGNOSTIC_MESSAGE_MAX_LENGTH);
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), message: atLimit })).toBe(true);
  });

  it("rejects a missing or malformed clientTs", () => {
    expect(isClientDiagnosticIngestRequest({ message: validRequest().message })).toBe(false);
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), clientTs: "not-a-date" })).toBe(
      false,
    );
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), clientTs: "2026-08-21" })).toBe(
      false,
    );
  });

  // `Date.parse` silently normalizes a calendar-invalid instant instead of rejecting it (e.g.
  // `2026-02-30T10:00:00.000Z` becomes `2026-03-02T10:00:00.000Z`), so a shape-only regex plus
  // `!Number.isNaN(Date.parse(...))` accepts a date that never happened on the calendar.
  it("rejects a calendar-invalid clientTs that Date.parse would silently normalize", () => {
    expect(
      isClientDiagnosticIngestRequest({ ...validRequest(), clientTs: "2026-02-30T10:00:00.000Z" }),
    ).toBe(false);
    // April has 30 days; the 31st does not exist.
    expect(
      isClientDiagnosticIngestRequest({ ...validRequest(), clientTs: "2026-04-31T00:00:00Z" }),
    ).toBe(false);
    // Hour 24 does not exist as a clock value.
    expect(
      isClientDiagnosticIngestRequest({ ...validRequest(), clientTs: "2026-08-21T24:00:00Z" }),
    ).toBe(false);
    // The last valid day of February in a non-leap year.
    expect(
      isClientDiagnosticIngestRequest({ ...validRequest(), clientTs: "2027-02-28T00:00:00Z" }),
    ).toBe(true);
  });

  it("rejects a readyState outside the closed 0|1|2 vocabulary", () => {
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), readyState: 3 })).toBe(false);
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), readyState: "1" })).toBe(false);
  });

  it("rejects a kind outside the closed vocabulary", () => {
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), kind: "crash" })).toBe(false);
  });

  it("rejects a correlationId that is empty or over the bounded length", () => {
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), correlationId: "" })).toBe(false);
    expect(
      isClientDiagnosticIngestRequest({ ...validRequest(), correlationId: "a".repeat(129) }),
    ).toBe(false);
  });

  it("accepts only a complete body-free git-change description response identity", () => {
    const gitChangeDescription = {
      action: "apply",
      disposition: "discarded",
      relationshipId: "rel-1",
      snapshotDigest: "a".repeat(64),
      proposalId: "prop-1",
      outcome: "observed",
    };
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), gitChangeDescription })).toBe(true);
    for (const invalid of [
      { ...gitChangeDescription, action: "write" },
      { ...gitChangeDescription, disposition: "ignored" },
      { ...gitChangeDescription, relationshipId: "/customer/repository" },
      { ...gitChangeDescription, snapshotDigest: "a".repeat(63) },
      { ...gitChangeDescription, proposalId: "contains spaces" },
      { ...gitChangeDescription, outcome: "body" },
    ]) {
      expect(
        isClientDiagnosticIngestRequest({ ...validRequest(), gitChangeDescription: invalid }),
      ).toBe(false);
    }
  });

  // This guard only asserts wire SHAPE (AGENTS.md: "reuse first" — the leaf must not duplicate
  // `correlation.ts`'s alphabet policy). A shape-conforming but semantically invalid id is the
  // server route's job to reject via `isValidCorrelationId`, never this guard's.
  it("accepts a correlationId shape that a stricter server-side policy would still reject", () => {
    expect(
      isClientDiagnosticIngestRequest({ ...validRequest(), correlationId: "not valid!!" }),
    ).toBe(true);
  });
});

describe("isClientDiagnosticKind", () => {
  it("accepts every declared kind", () => {
    for (const kind of CLIENT_DIAGNOSTIC_KINDS) {
      expect(isClientDiagnosticKind(kind)).toBe(true);
    }
  });

  it("rejects a value outside the closed vocabulary", () => {
    expect(isClientDiagnosticKind("crash")).toBe(false);
    expect(isClientDiagnosticKind(1)).toBe(false);
  });
});
