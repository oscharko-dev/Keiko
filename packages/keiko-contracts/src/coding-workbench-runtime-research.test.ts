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
    expect(result.errors.join(" ")).toContain(
      "pending must be absent when the session is unpaired",
    );
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

  it("rejects an empty host and a non-string host", () => {
    expect(
      validateCodingWorkbenchRuntimeResearchChannelPayload({
        session: "active",
        pending: pending({ host: "" }),
      }).ok,
    ).toBe(false);
    expect(
      validateCodingWorkbenchRuntimeResearchChannelPayload({
        session: "active",
        pending: pending({ host: 42 }),
      }).ok,
    ).toBe(false);
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
