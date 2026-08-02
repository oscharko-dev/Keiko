import { describe, expect, it } from "vitest";

import {
  CODING_WORKBENCH_RESEARCH_REQUEST_LINE_MAX_CHARS,
  unpairedCodingWorkbenchRuntimeResearchChannelPayload,
  validateCodingWorkbenchRuntimeResearchChannelPayload,
} from "./coding-workbench-runtime-research.js";

function pending(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "research-approval-1",
    host: "nodejs.org",
    requestLine: "/docs/latest/api/stream.html backpressure",
    expiresAt: "2026-07-20T10:00:00.000Z",
    ...overrides,
  };
}

function grant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    grantId: "grant-1",
    domains: ["developer.mozilla.org", "nodejs.org"],
    expiresAt: "2026-07-20T10:00:00.000Z",
    ...overrides,
  };
}

describe("coding workbench runtime research channel payload", () => {
  it("accepts an active payload carrying the reviewable host and request line", () => {
    const result = validateCodingWorkbenchRuntimeResearchChannelPayload({
      session: "active",
      pending: pending(),
    });

    expect(result.ok).toBe(true);
  });

  it("accepts an active payload with no pending ask", () => {
    expect(validateCodingWorkbenchRuntimeResearchChannelPayload({ session: "active" }).ok).toBe(
      true,
    );
  });

  it("accepts a validated live grant only on the active channel", () => {
    const active = validateCodingWorkbenchRuntimeResearchChannelPayload({
      session: "active",
      grant: grant(),
    });
    const unpaired = validateCodingWorkbenchRuntimeResearchChannelPayload({
      session: "unpaired",
      grant: grant(),
    });

    expect(active.ok).toBe(true);
    expect(unpaired).toMatchObject({ ok: false });
  });

  it("rejects malformed, private, empty, and widened grant projections", () => {
    for (const candidate of [
      grant({ domains: [] }),
      grant({ domains: ["127.0.0.1"] }),
      grant({ expiresAt: "soon" }),
      grant({ queryTextDigest: "forbidden" }),
      "grant-1",
    ]) {
      expect(
        validateCodingWorkbenchRuntimeResearchChannelPayload({
          session: "active",
          grant: candidate,
        }).ok,
      ).toBe(false);
    }
  });

  it("keeps the unpaired projection content-free and valid", () => {
    const unpaired = unpairedCodingWorkbenchRuntimeResearchChannelPayload();

    expect(unpaired).toEqual({ session: "unpaired" });
    expect(validateCodingWorkbenchRuntimeResearchChannelPayload(unpaired).ok).toBe(true);
  });

  it("rejects an unpaired payload that leaks a pending ask", () => {
    const result = validateCodingWorkbenchRuntimeResearchChannelPayload({
      session: "unpaired",
      pending: pending(),
    });

    if (result.ok) throw new Error("expected the unpaired-with-pending payload to be rejected");
    expect(result.errors.join(" ")).toContain("must be absent when the session is unpaired");
  });

  it("rejects an unknown session facet", () => {
    expect(validateCodingWorkbenchRuntimeResearchChannelPayload({ session: "guest" }).ok).toBe(
      false,
    );
  });

  it("rejects unknown keys on the payload and on the pending ask", () => {
    expect(
      validateCodingWorkbenchRuntimeResearchChannelPayload({ session: "active", extra: 1 }).ok,
    ).toBe(false);
    expect(
      validateCodingWorkbenchRuntimeResearchChannelPayload({
        session: "active",
        pending: pending({ url: "https://nodejs.org/" }),
      }).ok,
    ).toBe(false);
  });

  it("admits an empty request line because a bare root fetch has none", () => {
    expect(
      validateCodingWorkbenchRuntimeResearchChannelPayload({
        session: "active",
        pending: pending({ requestLine: "" }),
      }).ok,
    ).toBe(true);
  });

  it("rejects a request line beyond the review bound", () => {
    expect(
      validateCodingWorkbenchRuntimeResearchChannelPayload({
        session: "active",
        pending: pending({
          requestLine: "a".repeat(CODING_WORKBENCH_RESEARCH_REQUEST_LINE_MAX_CHARS + 1),
        }),
      }).ok,
    ).toBe(false);
  });

  it("rejects bidi and zero-width spoofing in the operator-visible request line", () => {
    for (const codePoint of [0x200b, 0x202e, 0x2066]) {
      expect(
        validateCodingWorkbenchRuntimeResearchChannelPayload({
          session: "active",
          pending: pending({
            requestLine: `/docs/${String.fromCodePoint(codePoint)}approved.example/path`,
          }),
        }).ok,
      ).toBe(false);
    }
  });

  it("rejects malformed request ids and non-public research hosts", () => {
    for (const candidate of [
      pending({ requestId: "not safe" }),
      pending({ host: "" }),
      pending({ host: 42 }),
      pending({ host: "localhost" }),
      pending({ host: "127.0.0.1" }),
      pending({ host: "https://nodejs.org" }),
      pending({ host: "NODEJS.ORG" }),
    ]) {
      expect(
        validateCodingWorkbenchRuntimeResearchChannelPayload({
          session: "active",
          pending: candidate,
        }).ok,
      ).toBe(false);
    }
  });

  it("rejects a non-UTC or malformed expiry", () => {
    expect(
      validateCodingWorkbenchRuntimeResearchChannelPayload({
        session: "active",
        pending: pending({ expiresAt: "2026-07-20T10:00:00+02:00" }),
      }).ok,
    ).toBe(false);
    expect(
      validateCodingWorkbenchRuntimeResearchChannelPayload({
        session: "active",
        pending: pending({ expiresAt: "soon" }),
      }).ok,
    ).toBe(false);
  });

  it("rejects a non-object payload and a non-object pending ask", () => {
    expect(validateCodingWorkbenchRuntimeResearchChannelPayload(null).ok).toBe(false);
    expect(validateCodingWorkbenchRuntimeResearchChannelPayload("active").ok).toBe(false);
    expect(
      validateCodingWorkbenchRuntimeResearchChannelPayload({ session: "active", pending: "x" }).ok,
    ).toBe(false);
  });
});
