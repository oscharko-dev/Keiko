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
    const headers = new Headers(lastInit(fetchMock).headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.has("Content-Type")).toBe(false);
    expect(headers.has("X-Keiko-CSRF")).toBe(false);
  });

  it("state-changing method sends CSRF + JSON Content-Type even without a body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await bffFetchJson("/api/x", { method: "DELETE" });
    const headers = new Headers(lastInit(fetchMock).headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Keiko-CSRF")).toBe("1");
  });

  it("adds Content-Type when a body is present on a non-state-changing method", async () => {
    // The memory-api / local-knowledge-api buildHeaders rule folded into the union: a body implies
    // JSON Content-Type. (No product route sends a GET body; this pins the union superset itself.)
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await bffFetchJson("/api/x", { method: "GET", body: "{}" });
    const headers = new Headers(lastInit(fetchMock).headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.has("X-Keiko-CSRF")).toBe(false);
  });

  it("lets caller-supplied init.headers win last (caller override)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await bffFetchJson("/api/x", { headers: { Accept: "application/pdf" } });
    const headers = new Headers(lastInit(fetchMock).headers);
    expect(headers.get("Accept")).toBe("application/pdf");
  });
});

describe("bffFetchJson — correlation id (RB-6, GEN-OBS-CORRELATION-601)", () => {
  it("sends a well-formed X-Keiko-Correlation-Id on every request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await bffFetchJson("/api/x");
    const headers = new Headers(lastInit(fetchMock).headers);
    expect(headers.get("X-Keiko-Correlation-Id")).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
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

  // The hook decorates the classified error; it must never replace it. A hook that throws on an
  // unexpected envelope shape used to surface as its own TypeError, hiding the server's code and
  // the correlation id the operator needs (workbench audit, 2026-09-03).
  // JSON that is not the envelope (an empty object, a bare string) used to be read as one: the
  // read threw a TypeError outside the parse guard and the caller rendered that instead of the
  // classified error (workbench audit, 2026-09-03).
  it("maps a JSON body without an error envelope to the fallback ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 500)));
    const enrichError = vi.fn();
    await expect(bffFetchJson("/api/x", undefined, { enrichError })).rejects.toMatchObject({
      code: "INTERNAL",
      status: 500,
    });
    expect(enrichError).toHaveBeenCalledWith(expect.any(ApiError), undefined);
  });

  // The boundary of `isBffErrorEnvelope`, case by case: every shape below is valid JSON that a
  // proxy or a partially-written handler can answer with, and each must yield the SAME classified
  // fallback `ApiError` and an `undefined` envelope — never a half-read envelope and never the
  // TypeError that reading one used to throw (#3381 review).
  it.each([
    ["a bare string", "oops"],
    ["a bare number", 500],
    ["a null body", null],
    ["an array", [{ code: "C", message: "m" }]],
    ["a null error", { error: null }],
    ["an error without a code", { error: { message: "m" } }],
    ["an error with a non-string code", { error: { code: 7, message: "m" } }],
    ["an error without a message", { error: { code: "C" } }],
    ["an error with a non-string message", { error: { code: "C", message: { text: "m" } } }],
  ])("maps %s to the fallback ApiError with no envelope", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body, 502)));
    const enrichError = vi.fn();

    await expect(bffFetchJson("/api/x", undefined, { enrichError })).rejects.toMatchObject({
      code: "INTERNAL",
      message: "HTTP 502",
      status: 502,
    });
    expect(enrichError).toHaveBeenCalledWith(expect.any(ApiError), undefined);
  });

  it("keeps the classified ApiError when opts.enrichError throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: { code: "C", message: "m" } }, 409)),
    );
    await expect(
      bffFetchJson("/api/x", undefined, {
        enrichError: () => {
          throw new TypeError("unexpected envelope");
        },
      }),
    ).rejects.toMatchObject({ code: "C", status: 409 });
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
