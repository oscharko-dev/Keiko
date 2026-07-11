import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TEST_LIMITS } from "./config.js";
import { createFeedbackIntakeHttpHandler } from "./http.js";
import type { ReceiptResult, SubmitResult } from "./types.js";

let server: Server | undefined;
afterEach(async () => {
  if (server !== undefined)
    await new Promise<void>((resolve) =>
      server?.close(() => {
        resolve();
      }),
    );
  server = undefined;
});

async function origin(
  service: Parameters<typeof createFeedbackIntakeHttpHandler>[0]["service"],
  overrides: Partial<Parameters<typeof createFeedbackIntakeHttpHandler>[0]> = {},
): Promise<string> {
  const handler = createFeedbackIntakeHttpHandler({
    service,
    limits: { ...DEFAULT_TEST_LIMITS, bodyBytes: 8 },
    proxy: { family: "forwarded", trustedCidrs: [] },
    ...overrides,
  });
  server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

async function nonEndingStatus(base: string, requestHead: string): Promise<number> {
  const target = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = createConnection(Number(target.port), target.hostname);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("non-ending upload was not bounded"));
    }, 1_000);
    socket.on("connect", () => socket.write(requestHead));
    socket.on("data", (chunk: Buffer) => {
      const match = /^HTTP\/1\.1 (\d{3})/u.exec(chunk.toString("latin1"));
      if (match?.[1] === undefined) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(Number(match[1]));
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function service(
  submitter: (bytes: Uint8Array) => Promise<SubmitResult>,
  receipt: () => Promise<ReceiptResult> = () =>
    Promise.resolve({ status: 404, body: { error: "invalid-request" } }),
): Parameters<typeof createFeedbackIntakeHttpHandler>[0]["service"] {
  return {
    beginAttempt: () => Promise.resolve({ ok: true, release: (): void => undefined }),
    submitReserved: (bytes) => submitter(bytes),
    submit: (bytes) => submitter(bytes),
    receipt,
  };
}

async function rawRequest(
  base: string,
  path: string,
  method: "GET" | "POST",
  headers: readonly string[],
  body?: string,
): Promise<number> {
  const target = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: target.hostname,
        port: target.port,
        path,
        method,
        headers: ["Host", target.host, ...headers],
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          resolve(response.statusCode ?? 0);
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("anonymous intake HTTP surface", () => {
  it("passes exact bytes and digest metadata without an envelope", async () => {
    let seen: Uint8Array | undefined;
    const base = await origin(
      service((bytes): Promise<SubmitResult> => {
        seen = bytes;
        return Promise.resolve({ status: 422, body: { error: "report-rejected" } });
      }),
    );
    const response = await fetch(`${base}/v1/feedback/reports`, {
      method: "POST",
      headers: { "content-type": "application/json", "keiko-feedback-body-sha256": "0".repeat(64) },
      body: "{}",
    });
    expect(response.status).toBe(422);
    expect(new TextDecoder().decode(seen)).toBe("{}");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects unsupported encoding, media, and oversized streaming bodies before service", async () => {
    let calls = 0;
    const submitter = service((): Promise<SubmitResult> => {
      calls += 1;
      return Promise.resolve({
        status: 202 as const,
        body: { receiptId: "a", receiptSecret: "b", expiresAt: "c" },
      });
    });
    const base = await origin(submitter);
    const headers = { "keiko-feedback-body-sha256": "0".repeat(64) };
    expect(
      (
        await fetch(`${base}/v1/feedback/reports`, {
          method: "POST",
          headers: { ...headers, "content-type": "text/plain" },
          body: "{}",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await fetch(`${base}/v1/feedback/reports`, {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
            "content-encoding": "identity",
          },
          body: "{}",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await fetch(`${base}/v1/feedback/reports`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: "123456789",
        })
      ).status,
    ).toBe(413);
    expect(calls).toBe(0);
  });

  it("exposes only the fixed receipt operation with a uniform 404", async () => {
    const base = await origin(
      service(
        () => Promise.resolve({ status: 422, body: { error: "report-rejected" } }),
        () => Promise.resolve({ status: 404, body: { error: "invalid-request" } }),
      ),
    );
    expect((await fetch(`${base}/health`)).status).toBe(404);
    const response = await fetch(`${base}/v1/feedback/receipts/${"A".repeat(22)}`, {
      headers: { authorization: `Keiko-Receipt ${"A".repeat(43)}` },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "invalid-request" });
  });

  it("rejects duplicate raw submit headers before payload admission", async () => {
    let submissions = 0;
    const base = await origin(
      service(() => {
        submissions += 1;
        return Promise.resolve({ status: 422, body: { error: "report-rejected" } });
      }),
    );
    const digest = "0".repeat(64);
    const cases: readonly [string, string][] = [
      ["Content-Type", "application/json"],
      ["Keiko-Feedback-Body-SHA256", digest],
      ["Forwarded", "for=127.0.0.1"],
      ["X-Forwarded-For", "127.0.0.1"],
    ];
    for (const [name, value] of cases) {
      const status = await rawRequest(
        base,
        "/v1/feedback/reports",
        "POST",
        [
          "Content-Type",
          "application/json",
          "Keiko-Feedback-Body-SHA256",
          digest,
          name,
          value,
          name,
          value,
          "Content-Length",
          "2",
        ],
        "{}",
      );
      expect(status, name).toBe(415);
    }
    expect(submissions).toBe(0);
  });

  it("rejects duplicate raw receipt authorization with the uniform 404", async () => {
    let lookups = 0;
    const base = await origin(
      service(
        () => Promise.resolve({ status: 422, body: { error: "report-rejected" } }),
        () => {
          lookups += 1;
          return Promise.resolve({ status: 404, body: { error: "invalid-request" } });
        },
      ),
    );
    const credential = `Keiko-Receipt ${"A".repeat(43)}`;
    const status = await rawRequest(base, `/v1/feedback/receipts/${"A".repeat(22)}`, "GET", [
      "Authorization",
      credential,
      "Authorization",
      credential,
    ]);

    expect(status).toBe(404);
    expect(lookups).toBe(0);
  });

  it("charges but rejects malformed, ambiguous, and overlong trusted proxy chains", async () => {
    let attempts = 0;
    let submissions = 0;
    const base = await origin(
      {
        ...service(() => {
          submissions += 1;
          return Promise.resolve({ status: 422, body: { error: "report-rejected" } });
        }),
        beginAttempt: () => {
          attempts += 1;
          return Promise.resolve({ ok: true, release: (): void => undefined });
        },
      },
      {
        proxy: { family: "forwarded", trustedCidrs: ["127.0.0.0/8"] },
        limits: { ...DEFAULT_TEST_LIMITS, bodyBytes: 8, proxyHops: 1 },
      },
    );
    const cases = [
      { forwarded: "for=garbage" },
      { forwarded: "for=198.51.100.1, for=198.51.100.2" },
      { forwarded: "for=198.51.100.1", "x-forwarded-for": "198.51.100.1" },
    ];
    for (const headers of cases) {
      const response = await fetch(`${base}/v1/feedback/reports`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "keiko-feedback-body-sha256": "0".repeat(64),
          ...headers,
        },
        body: "{}",
      });
      expect(response.status).toBe(400);
    }
    expect(attempts).toBe(3);
    expect(submissions).toBe(0);
  });

  it("bounds non-ending chunked uploads at the byte cap and on pre-body denial", async () => {
    const acceptedBase = await origin(
      service(() => Promise.resolve({ status: 422, body: { error: "report-rejected" } })),
    );
    const head = (base: string, chunk: string): string => {
      const host = new URL(base).host;
      return `POST /v1/feedback/reports HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nKeiko-Feedback-Body-SHA256: ${"0".repeat(64)}\r\nTransfer-Encoding: chunked\r\n\r\n${chunk}`;
    };
    await expect(
      nonEndingStatus(acceptedBase, head(acceptedBase, "9\r\n123456789\r\n")),
    ).resolves.toBe(413);
    await new Promise<void>((resolve) => {
      server?.close(() => {
        resolve();
      });
    });
    server = undefined;
    const denials: readonly SubmitResult[] = [
      {
        status: 429,
        body: { error: "rate-limited", message: "Try again later." },
        retryAfterSeconds: 300,
      },
      { status: 503, body: { error: "temporarily-unavailable" } },
    ];
    for (const result of denials) {
      const deniedBase = await origin({
        ...service(() => Promise.resolve({ status: 422, body: { error: "report-rejected" } })),
        beginAttempt: () => Promise.resolve({ ok: false, result }),
      });
      await expect(nonEndingStatus(deniedBase, head(deniedBase, ""))).resolves.toBe(result.status);
      await new Promise<void>((resolve) => {
        server?.close(() => {
          resolve();
        });
      });
      server = undefined;
    }
  });
});
