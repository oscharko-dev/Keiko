// Contract tests for the shared BFF fetch scaffold (GEN-DUP-NEAR-004). These pin the SUPERSET
// behavior every satellite `*-api.ts` now delegates to, so a future change to the helper cannot
// silently regress any call site: the header union, the error-envelope parse (+ friendly override),
// the enrichError hook, the optional validator, and the 204 → undefined short-circuit.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { bffFetchJson } from "./http";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function lastInit(fetchMock: ReturnType<typeof vi.fn>): RequestInit {
  const calls = fetchMock.mock.calls;
  return (calls[calls.length - 1] as [string, RequestInit])[1];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bffFetchJson — header union", () => {
  it("GET sends only Accept (no CSRF, no Content-Type)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await bffFetchJson("/api/x");
    const headers = lastInit(fetchMock).headers as Record<string, string>;
    expect(headers.Accept).toBe("application/json");
    expect(headers["Content-Type"]).toBeUndefined();
    expect(headers["X-Keiko-CSRF"]).toBeUndefined();
  });

  it("state-changing method sends CSRF + JSON Content-Type even without a body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await bffFetchJson("/api/x", { method: "DELETE" });
    const headers = lastInit(fetchMock).headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Keiko-CSRF"]).toBe("1");
  });

  it("adds Content-Type when a body is present on a non-state-changing method", async () => {
    // The memory-api / local-knowledge-api buildHeaders rule folded into the union: a body implies
    // JSON Content-Type. (No product route sends a GET body; this pins the union superset itself.)
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await bffFetchJson("/api/x", { method: "GET", body: "{}" });
    const headers = lastInit(fetchMock).headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Keiko-CSRF"]).toBeUndefined();
  });

  it("lets caller-supplied init.headers win last (spread-style override)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await bffFetchJson("/api/x", { headers: { Accept: "application/pdf" } });
    const headers = lastInit(fetchMock).headers as Record<string, string>;
    expect(headers.Accept).toBe("application/pdf");
  });
});

describe("bffFetchJson — correlation id (RB-6, GEN-OBS-CORRELATION-601)", () => {
  it("sends a well-formed X-Keiko-Correlation-Id on every request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await bffFetchJson("/api/x");
    const headers = lastInit(fetchMock).headers as Record<string, string>;
    expect(headers["X-Keiko-Correlation-Id"]).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
  });

  it("attaches the server-echoed correlation id to a thrown ApiError", async () => {
    const serverId = "server-echoed-000123";
    const response = new Response(
      JSON.stringify({ error: { code: "INTERNAL", message: "boom" } }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", "X-Keiko-Correlation-Id": serverId },
      },
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(bffFetchJson("/api/x")).rejects.toMatchObject({
      code: "INTERNAL",
      correlationId: serverId,
    });
  });

  it("falls back to the envelope correlationId, then the client id, when no header is present", async () => {
    const response = new Response(
      JSON.stringify({
        error: { code: "INTERNAL", message: "boom", correlationId: "env-id-000999" },
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    let thrown: ApiError | undefined;
    try {
      await bffFetchJson("/api/x");
    } catch (error) {
      thrown = error as ApiError;
    }
    expect(thrown?.correlationId).toBe("env-id-000999");
  });
});

describe("bffFetchJson — success bodies", () => {
  it("returns undefined on 204 No Content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(bffFetchJson("/api/x", { method: "DELETE" })).resolves.toBeUndefined();
  });

  it("parses and returns the JSON body on 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ value: 7 })));
    await expect(bffFetchJson<{ value: number }>("/api/x")).resolves.toEqual({ value: 7 });
  });

  it("routes the body through opts.validator when supplied", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ raw: true })));
    const validator = vi.fn((_: string, value: unknown) => ({ mapped: value }));
    const result = await bffFetchJson<{ mapped: unknown }>("/api/x", undefined, { validator });
    expect(validator).toHaveBeenCalledWith("/api/x", { raw: true });
    expect(result).toEqual({ mapped: { raw: true } });
  });
});

describe("bffFetchJson — error handling", () => {
  it("maps a parseable error envelope to ApiError(code, message, status)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: { code: "DENIED", message: "no" } }, 403)),
    );
    await expect(bffFetchJson("/api/x")).rejects.toMatchObject({
      code: "DENIED",
      message: "no",
      status: 403,
    });
  });

  it("uses the machine HTTP <status> fallback on an unparseable body by default", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("stack", { status: 500 })));
    await expect(bffFetchJson("/api/x")).rejects.toMatchObject({
      code: "INTERNAL",
      message: "HTTP 500",
      status: 500,
    });
  });

  it("uses opts.parseFailureMessage on an unparseable body when supplied", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("stack", { status: 500 })));
    await expect(
      bffFetchJson("/api/x", undefined, {
        parseFailureMessage: (status) => `friendly ${status.toString()}`,
      }),
    ).rejects.toMatchObject({ code: "INTERNAL", message: "friendly 500", status: 500 });
  });

  it("runs opts.enrichError with the parsed envelope so callers can attach fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: { code: "C", message: "m", failureClass: "retryable" } }, 409),
        ),
    );
    await expect(
      bffFetchJson("/api/x", undefined, {
        enrichError: (error, envelope) => {
          Object.assign(error, { failureClass: envelope?.error["failureClass"] });
        },
      }),
    ).rejects.toMatchObject({ code: "C", failureClass: "retryable", status: 409 });
  });

  it("runs opts.enrichError with an undefined envelope on a parse failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("raw", { status: 500 })));
    const enrichError = vi.fn();
    await expect(bffFetchJson("/api/x", undefined, { enrichError })).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(enrichError).toHaveBeenCalledWith(expect.any(ApiError), undefined);
  });
});
