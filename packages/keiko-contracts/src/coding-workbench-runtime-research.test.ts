import { describe, expect, expectTypeOf, it } from "vitest";
import type { CodingWorkbenchValidationResult } from "@oscharko-dev/keiko-contracts";
import {
  validateCodingWorkbenchRuntimeResearchChannelPayload as publicResearchChannel,
  type CodingWorkbenchRuntimeResearchChannelPayload,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-research";

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

describe("C2 owning research domain admission", () => {
  it("refuses a numeric domain hidden by a caller-owned every", () => {
    const domains: unknown[] = [3];
    Object.defineProperty(domains, "every", { value: (): boolean => true });
    expect(
      validateCodingWorkbenchRuntimeResearchChannelPayload({
        session: "active",
        grant: grant({ domains }),
      }).ok,
    ).toBe(false);
  });

  it("retains the healthy grant and domain references", () => {
    const value = { session: "active", grant: grant() };
    const result = validateCodingWorkbenchRuntimeResearchChannelPayload(value);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(value);
  });
});

type PublicResearchChannelParse =
  CodingWorkbenchValidationResult<CodingWorkbenchRuntimeResearchChannelPayload>;

export function parsePublicRuntimeResearchChannel(
  input: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeResearchChannelPayload> {
  const result = publicResearchChannel(input);
  return result;
}

describe("runtime research channel public parser (#3918)", () => {
  it("retains checked pending and grant values and nested identity", () => {
    const input = { session: "active", pending: pending(), grant: grant() };
    const result = parsePublicRuntimeResearchChannel(input);
    expect(result).toEqual({ ok: true, value: input });
    if (!result.ok) throw new TypeError("healthy public research refused");
    expect(result.value).toBe(input);
    expect(result.value.pending).toBe(input.pending);
    expect(result.value.grant).toBe(input.grant);
    expect(result.value.grant?.domains).toBe(input.grant.domains);
    expect(result.value.pending?.host).toBe("nodejs.org");
  });

  it("retains omitted versus own undefined optional state on active and unpaired payloads", () => {
    for (const input of [
      { session: "active" },
      { session: "active", pending: undefined, grant: undefined },
      { session: "unpaired" },
      { session: "unpaired", pending: undefined, grant: undefined },
    ]) {
      const result = parsePublicRuntimeResearchChannel(input);
      expect(result).toEqual({ ok: true, value: input });
      if (!result.ok) throw new TypeError("healthy optional public research refused");
      expect(result.value).toBe(input);
      expect(Object.hasOwn(result.value, "pending")).toBe(Object.hasOwn(input, "pending"));
      expect(Object.hasOwn(result.value, "grant")).toBe(Object.hasOwn(input, "grant"));
    }
  });

  it("refuses malformed payloads with exact eager ordered diagnostics", () => {
    for (const input of [null, [], "research", 1])
      expect(parsePublicRuntimeResearchChannel(input)).toEqual({
        ok: false,
        errors: ["research channel payload must be an object"],
      });
    expect(
      parsePublicRuntimeResearchChannel({
        session: "guest",
        extra: true,
        pending: {
          requestId: "!",
          host: "localhost",
          requestLine: 1,
          expiresAt: "invalid",
          extra: true,
        },
      }),
    ).toEqual({
      ok: false,
      errors: [
        "researchChannelPayload.extra is not allowed",
        "researchChannelPayload.session is invalid",
        "pendingResearch.extra is not allowed",
        "pendingResearch.requestId must be a bounded safe identifier",
        "pendingResearch.host must be a canonical public domain",
        "pendingResearch.requestLine must be a bounded string",
        "pendingResearch.expiresAt must be a strict UTC instant",
      ],
    });
  });

  it("refuses research state on the unpaired public channel", () => {
    for (const input of [
      { session: "unpaired", pending: pending() },
      { session: "unpaired", grant: grant() },
    ])
      expect(parsePublicRuntimeResearchChannel(input)).toEqual({
        ok: false,
        errors: [
          "researchChannelPayload research state must be absent when the session is unpaired",
        ],
      });
  });

  it("retains the second observed pending-field refusal", () => {
    let reads = 0;
    const input = {
      session: "active",
      get pending(): unknown {
        return ++reads === 1 ? pending() : 1;
      },
    };
    expect(parsePublicRuntimeResearchChannel(input)).toEqual({
      ok: false,
      errors: ["researchChannelPayload.pending must be an object"],
    });
    expect(reads).toBe(2);
  });

  it("pins source public and forwarding checked return types", () => {
    expectTypeOf(
      validateCodingWorkbenchRuntimeResearchChannelPayload,
    ).returns.toEqualTypeOf<PublicResearchChannelParse>();
    expectTypeOf(publicResearchChannel).returns.toEqualTypeOf<PublicResearchChannelParse>();
    expectTypeOf(
      parsePublicRuntimeResearchChannel,
    ).returns.toEqualTypeOf<PublicResearchChannelParse>();
    type Success = Extract<ReturnType<typeof publicResearchChannel>, { readonly ok: true }>;
    expectTypeOf<Success["value"]>().toEqualTypeOf<CodingWorkbenchRuntimeResearchChannelPayload>();
    type Failure = Extract<ReturnType<typeof publicResearchChannel>, { readonly ok: false }>;
    expectTypeOf<Failure["errors"]>().toEqualTypeOf<readonly string[]>();
  });
});
