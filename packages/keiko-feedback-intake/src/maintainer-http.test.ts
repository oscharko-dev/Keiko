import { createHash } from "node:crypto";
import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { FeedbackMaintainerPermissionV1 } from "@oscharko-dev/keiko-contracts/feedback-maintainer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MaintainerAuthError } from "./maintainer-auth.js";
import { FeedbackPublicationError } from "./feedback-publication-types.js";
import { createMaintainerHttpHandler, type MaintainerHttpOptions } from "./maintainer-http.js";
import { MaintainerLoginLimiter } from "./maintainer-login-limiter.js";
import { maintainerCsrfToken } from "./maintainer-store.js";
import { FeedbackReviewError } from "./feedback-review-types.js";

const CAPABILITY = "A".repeat(43);
const BROWSER = "B".repeat(43);
const ITEM = "11111111-1111-4111-8111-111111111111";
const AT = new Date(Date.now() + 120_000);
const openServers: ReturnType<typeof createServer>[] = [];

function csrfHash(token: string): Uint8Array {
  return createHash("sha256")
    .update("keiko-maintainer-csrf-v1")
    .update("\0")
    .update(token)
    .digest();
}

interface Harness {
  readonly options: MaintainerHttpOptions;
  readonly auth: {
    readonly login: ReturnType<typeof vi.fn>;
    readonly callback: ReturnType<typeof vi.fn>;
    readonly session: ReturnType<typeof vi.fn>;
    readonly logout: ReturnType<typeof vi.fn>;
  };
  readonly query: {
    readonly list: ReturnType<typeof vi.fn>;
    readonly detail: ReturnType<typeof vi.fn>;
    readonly hold: ReturnType<typeof vi.fn>;
    readonly audit: ReturnType<typeof vi.fn>;
  };
  readonly review: { readonly execute: ReturnType<typeof vi.fn> };
}

function harness(
  permissions: readonly FeedbackMaintainerPermissionV1[],
  legalHoldPolicyKeys: readonly string[] = [],
): Harness {
  const csrfToken = maintainerCsrfToken(CAPABILITY);
  const authMocks = {
    login: vi.fn().mockResolvedValue({
      url: new URL("https://idp.example/authorize?state=opaque"),
      browserCapability: BROWSER,
    }),
    callback: vi.fn().mockResolvedValue({
      capability: CAPABILITY,
      csrfToken,
      absoluteExpiresAt: AT,
    }),
    session: vi.fn().mockResolvedValue({
      issuer: "https://idp.example/tenant/",
      subject: "maintainer-1",
      permissions,
      permissionPolicyVersion: "policy-v1",
      csrfHash: csrfHash(csrfToken),
      absoluteExpiresAt: AT,
    }),
    logout: vi.fn().mockResolvedValue(undefined),
  };
  const query = {
    list: vi.fn().mockResolvedValue({ items: [] }),
    detail: vi.fn().mockResolvedValue({ itemId: ITEM }),
    hold: vi.fn().mockResolvedValue({ itemId: ITEM, legalHold: { status: "expired" } }),
    audit: vi.fn().mockResolvedValue([]),
  };
  const review = {
    execute: vi.fn().mockResolvedValue({ itemId: ITEM, state: "archived", version: 2 }),
  };
  return {
    auth: authMocks,
    query,
    review,
    options: {
      publicOrigin: "https://maintainer.example",
      auth: authMocks,
      query,
      review,
      loginLimiter: new MaintainerLoginLimiter({
        perSource: 100,
        global: 100,
        windowMs: 60_000,
        concurrency: 10,
      }),
      proxy: { family: "forwarded", trustedCidrs: [], maxHops: 2 },
      legalHoldPolicyKeys,
    },
  };
}

async function listen(options: MaintainerHttpOptions): Promise<string> {
  const handler = createMaintainerHttpHandler(options);
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
}

function sessionHeaders(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    Cookie: `__Host-keiko-feedback-session=${CAPABILITY}`,
    ...extra,
  };
}

function rawStatus(
  origin: string,
  path: string,
  headers: OutgoingHttpHeaders = {},
  method = "GET",
  body?: string | Uint8Array,
): Promise<number> {
  const target = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        method,
        path,
        headers,
      },
      (res) => {
        res.resume();
        res.once("end", () => {
          resolve(res.statusCode ?? 0);
        });
      },
    );
    req.once("error", reject);
    req.end(body);
  });
}

function rawResponse(
  origin: string,
  path: string,
  headers: OutgoingHttpHeaders = {},
  method = "GET",
): Promise<{ readonly status: number; readonly headers: IncomingHttpHeaders }> {
  const target = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: target.hostname, port: target.port, method, path, headers },
      (res) => {
        res.resume();
        res.once("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers });
        });
      },
    );
    req.once("error", reject);
    req.end();
  });
}

function terminatedUpload(origin: string, chunk: Buffer, end: boolean): Promise<void> {
  const target = new URL(origin);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      reject(new Error("upload was not terminated"));
    }, 6_500);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const req = request({
      host: target.hostname,
      port: target.port,
      method: "POST",
      path: `/v1/maintainer/reviews/${ITEM}/actions`,
      headers: sessionHeaders({
        "Content-Type": "application/json",
        Origin: "https://maintainer.example",
        "keiko-feedback-csrf": maintainerCsrfToken(CAPABILITY),
      }),
    });
    req.once("error", finish);
    req.once("close", finish);
    req.write(chunk);
    if (end) req.end();
  });
}

afterEach(async (): Promise<void> => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          });
        }),
    ),
  );
});

describe("maintainer HTTP boundary", () => {
  it("applies HSTS to maintainer error responses", async () => {
    const { options } = harness(["feedback.review"]);
    const origin = await listen(options);
    const response = await fetch(`${origin}/v1/maintainer/auth/session`);
    expect(response.status).toBe(401);
    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
  });

  it("serves only inert same-origin static review assets with restrictive headers", async () => {
    const { options } = harness(["feedback.review"]);
    const origin = await listen(options);
    const page = await fetch(`${origin}/maintainer/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(page.headers.get("vary")).toBe("Accept-Encoding");
    expect(page.headers.get("content-security-policy")).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; font-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
    );
    const html = await page.text();
    expect(html).toContain('type="module" src="/maintainer/app.js"');
    expect(html).toContain('href="/maintainer/app.css"');
    expect(html).not.toContain("<style");
    expect(html).not.toContain("<script>");
    const script = await fetch(`${origin}/maintainer/app.js`);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(script.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(await script.text()).not.toContain("innerHTML");
    const brotli = await rawResponse(origin, "/maintainer/app.js", {
      "Accept-Encoding": "br, gzip",
    });
    expect(brotli.status).toBe(200);
    expect(brotli.headers["content-encoding"]).toBe("br");
    expect(brotli.headers.vary).toBe("Accept-Encoding");
    const identity = await rawResponse(origin, "/maintainer/app.js", {
      "Accept-Encoding": "identity",
    });
    expect(identity.headers["content-encoding"]).toBeUndefined();
    const duplicate = await rawResponse(origin, "/maintainer/app.js", {
      "Accept-Encoding": ["br", "gzip"],
    });
    expect(duplicate.headers["content-encoding"]).toBeUndefined();
    const head = await rawResponse(
      origin,
      "/maintainer/app.js",
      { "Accept-Encoding": "br" },
      "HEAD",
    );
    expect(head.headers["content-encoding"]).toBe("br");
    expect(head.headers["content-length"]).toBe(brotli.headers["content-length"]);
    for (const path of ["maintainer-ui-copy.js", "maintainer-ui-dom.js"]) {
      const module = await fetch(`${origin}/maintainer/${path}`);
      expect(module.headers.get("content-type")).toContain("text/javascript");
      expect(await module.text()).not.toContain("innerHTML");
    }
    await expect(fetch(`${origin}/assets/keiko-logo.svg`)).resolves.toMatchObject({ status: 404 });
  });

  it("sets hardened host cookies and browser-binds the callback", async () => {
    const { options, auth } = harness(["feedback.review"]);
    const origin = await listen(options);
    const login = await fetch(`${origin}/v1/maintainer/auth/login`, { redirect: "manual" });
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("https://idp.example/authorize?state=opaque");
    expect(login.headers.get("set-cookie")).toContain(
      `__Host-keiko-feedback-oidc=${BROWSER}; Path=/; Max-Age=300; Secure; HttpOnly; SameSite=Lax`,
    );

    const missing = await fetch(`${origin}/v1/maintainer/auth/callback?code=code&state=state`, {
      redirect: "manual",
    });
    expect(missing.status).toBe(400);
    expect(auth.callback).not.toHaveBeenCalled();

    const callback = await fetch(`${origin}/v1/maintainer/auth/callback?code=code&state=state`, {
      redirect: "manual",
      headers: {
        Cookie: `__Host-keiko-feedback-oidc=${BROWSER}; __Host-keiko-feedback-session=${CAPABILITY}`,
      },
    });
    expect(callback.status).toBe(303);
    expect(callback.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(callback.headers.get("location")).toBe("https://maintainer.example/maintainer/");
    expect(auth.callback).toHaveBeenCalledWith(expect.any(URL), BROWSER, CAPABILITY);
    const cookies = callback.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies.join("\n")).toContain("__Host-keiko-feedback-oidc=; Path=/; Max-Age=0");
    expect(cookies.join("\n")).toContain(`__Host-keiko-feedback-session=${CAPABILITY}; Path=/`);
  });

  it("returns no principal attributes from the public session DTO", async () => {
    const { options } = harness(["feedback.review"]);
    const origin = await listen(options);
    const response = await fetch(`${origin}/v1/maintainer/auth/session`, {
      headers: sessionHeaders(),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
    const value = (await response.json()) as Record<string, unknown>;
    expect(value).toEqual({
      permissions: ["feedback.review"],
      csrfToken: maintainerCsrfToken(CAPABILITY),
      absoluteExpiresAt: AT.toISOString(),
    });
    expect(value).not.toHaveProperty("issuer");
    expect(value).not.toHaveProperty("subject");
  });

  it("exposes legal-hold policy keys and governance metadata only to legal-hold sessions", async () => {
    const legal = harness(["feedback.review", "feedback.legal-hold"], ["retention-review"]);
    const origin = await listen(legal.options);
    const session = await fetch(`${origin}/v1/maintainer/auth/session`, {
      headers: sessionHeaders(),
    });
    expect(await session.json()).toMatchObject({ legalHoldPolicyKeys: ["retention-review"] });
    const hold = await fetch(`${origin}/v1/maintainer/reviews/${ITEM}/hold`, {
      headers: sessionHeaders(),
    });
    expect(hold.status).toBe(200);
    expect(await hold.json()).toEqual({ itemId: ITEM, legalHold: { status: "expired" } });

    const ordinary = harness(["feedback.review"]);
    const denied = await listen(ordinary.options);
    await expect(
      fetch(`${denied}/v1/maintainer/reviews/${ITEM}/hold`, { headers: sessionHeaders() }),
    ).resolves.toMatchObject({ status: 403 });
  });

  it.each([
    [new MaintainerAuthError("invalid-callback"), 400],
    [new MaintainerAuthError("authorization-denied"), 403],
    [new Error("OIDC_PROVIDER_SECRET_SENTINEL"), 503],
  ] as const)(
    "maps callback failure classes without leaking provider text",
    async (error, status) => {
      const base = harness(["feedback.review"]);
      base.auth.callback.mockRejectedValueOnce(error);
      const origin = await listen(base.options);
      const response = await fetch(`${origin}/v1/maintainer/auth/callback?code=code&state=state`, {
        redirect: "manual",
        headers: { Cookie: `__Host-keiko-feedback-oidc=${BROWSER}` },
      });
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain("OIDC_PROVIDER_SECRET_SENTINEL");
    },
  );

  it("rejects absolute targets and duplicate cookie, origin, or CSRF headers", async () => {
    const { options, auth } = harness(["feedback.review"]);
    const origin = await listen(options);
    await expect(
      rawStatus(origin, "https://maintainer.example/v1/maintainer/auth/session"),
    ).resolves.toBe(400);
    await expect(
      rawStatus(origin, "/v1/maintainer/auth/session", {
        Cookie: [
          `__Host-keiko-feedback-session=${CAPABILITY}`,
          `__Host-keiko-feedback-session=${CAPABILITY}`,
        ],
      }),
    ).resolves.toBe(401);
    expect(auth.session).not.toHaveBeenCalled();
    const actionPath = `/v1/maintainer/reviews/${ITEM}/actions`;
    const actionBody = JSON.stringify({
      action: "archive",
      expectedVersion: 1,
      expectedPayloadDigest: "a".repeat(64),
      idempotencyKey: "duplicate-header-key",
    });
    const base = {
      Cookie: `__Host-keiko-feedback-session=${CAPABILITY}`,
      "Content-Type": "application/json",
      "keiko-feedback-csrf": maintainerCsrfToken(CAPABILITY),
    };
    await expect(
      rawStatus(
        origin,
        actionPath,
        { ...base, Origin: ["https://maintainer.example", "https://maintainer.example"] },
        "POST",
        actionBody,
      ),
    ).resolves.toBe(403);
    await expect(
      rawStatus(
        origin,
        actionPath,
        {
          ...base,
          Origin: "https://maintainer.example",
          "Content-Type": ["application/json", "application/json"],
        },
        "POST",
        actionBody,
      ),
    ).resolves.toBe(403);
    await expect(
      rawStatus(
        origin,
        actionPath,
        {
          ...base,
          Origin: "https://maintainer.example",
          "keiko-feedback-csrf": [maintainerCsrfToken(CAPABILITY), maintainerCsrfToken(CAPABILITY)],
        },
        "POST",
        actionBody,
      ),
    ).resolves.toBe(403);
  });

  it("terminates oversized and deadline-exceeding uploads before action execution", async () => {
    const { options, review } = harness(["feedback.review"]);
    const origin = await listen(options);
    await expect(terminatedUpload(origin, Buffer.alloc(16_385, 65), true)).resolves.toBeUndefined();
    const started = Date.now();
    await expect(terminatedUpload(origin, Buffer.from("{"), false)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
    expect(review.execute).not.toHaveBeenCalled();
  }, 8_000);

  it("fails closed on CSRF, removed approval, and missing permissions", async () => {
    const { options, review, query } = harness(["feedback.review"]);
    const origin = await listen(options);
    const actionUrl = `${origin}/v1/maintainer/reviews/${ITEM}/actions`;
    const archive = JSON.stringify({
      action: "archive",
      expectedVersion: 1,
      expectedPayloadDigest: "a".repeat(64),
      idempotencyKey: "idempotency-key-1",
    });
    for (const headers of [
      sessionHeaders({ "Content-Type": "application/json" }),
      sessionHeaders({
        "Content-Type": "application/json",
        Origin: "https://evil.example",
        "keiko-feedback-csrf": maintainerCsrfToken(CAPABILITY),
      }),
      sessionHeaders({
        "Content-Type": "text/plain",
        Origin: "https://maintainer.example",
        "keiko-feedback-csrf": maintainerCsrfToken(CAPABILITY),
      }),
    ]) {
      const denied = await fetch(actionUrl, { method: "POST", headers, body: archive });
      expect(denied.status).toBe(403);
    }
    expect(review.execute).not.toHaveBeenCalled();

    const allowedHeaders = sessionHeaders({
      "Content-Type": "application/json",
      Origin: "https://maintainer.example",
      "keiko-feedback-csrf": maintainerCsrfToken(CAPABILITY),
    });
    expect(
      (await fetch(actionUrl, { method: "POST", headers: allowedHeaders, body: archive })).status,
    ).toBe(200);
    expect(review.execute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "archive" }),
      false,
    );
    expect(
      (
        await fetch(actionUrl, {
          method: "POST",
          headers: allowedHeaders,
          body: JSON.stringify({ ...JSON.parse(archive), action: "approve" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (await fetch(`${origin}/v1/maintainer/audit`, { headers: sessionHeaders() })).status,
    ).toBe(403);
    await fetch(`${origin}/v1/maintainer/reviews`, { headers: sessionHeaders() });
    expect(query.list).toHaveBeenCalledWith(expect.objectContaining({ includePrivate: false }));
  });

  it("maps domain conflicts and outages without leaking exception text", async () => {
    const base = harness(["feedback.review"]);
    const diagnostics: { readonly category: string; readonly correlationId: string }[] = [];
    const origin = await listen({
      ...base.options,
      diagnostics: {
        event: (category, correlationId): void => {
          diagnostics.push({ category, correlationId });
        },
      },
    });
    base.query.list.mockRejectedValueOnce(new Error("DB_SECRET_SENTINEL"));
    const outage = await fetch(`${origin}/v1/maintainer/reviews`, {
      headers: sessionHeaders(),
    });
    expect(outage.status).toBe(503);
    expect(await outage.text()).not.toContain("DB_SECRET_SENTINEL");
    expect(diagnostics[0]).toEqual({
      category: "dependency-unavailable",
      correlationId: outage.headers.get("x-correlation-id"),
    });

    base.review.execute.mockRejectedValueOnce(new FeedbackReviewError("cas-mismatch"));
    const conflict = await fetch(`${origin}/v1/maintainer/reviews/${ITEM}/actions`, {
      method: "POST",
      headers: sessionHeaders({
        "Content-Type": "application/json",
        Origin: "https://maintainer.example",
        "keiko-feedback-csrf": maintainerCsrfToken(CAPABILITY),
      }),
      body: JSON.stringify({
        action: "archive",
        expectedVersion: 1,
        expectedPayloadDigest: "a".repeat(64),
        idempotencyKey: "conflict-mapping-key",
      }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "conflict" });
    expect(diagnostics[1]?.category).toBe("conflict");
  });

  it("rejects malformed review UUIDs without querying PostgreSQL or emitting diagnostics", async () => {
    const base = harness(["feedback.review"]);
    const diagnostics = vi.fn();
    const origin = await listen({
      ...base.options,
      diagnostics: { event: diagnostics },
    });
    const malformedPath = await fetch(`${origin}/v1/maintainer/reviews/not-a-uuid`, {
      headers: sessionHeaders(),
    });
    expect(malformedPath.status).toBe(404);
    expect(base.query.detail).not.toHaveBeenCalled();

    const malformedTarget = await fetch(`${origin}/v1/maintainer/reviews/${ITEM}/actions`, {
      method: "POST",
      headers: sessionHeaders({
        "Content-Type": "application/json",
        Origin: "https://maintainer.example",
        "keiko-feedback-csrf": maintainerCsrfToken(CAPABILITY),
      }),
      body: JSON.stringify({
        action: "mark-duplicate",
        targetItemId: "not-a-uuid",
        expectedVersion: 1,
        expectedPayloadDigest: "a".repeat(64),
        idempotencyKey: "malformed-target-key",
      }),
    });
    expect(malformedTarget.status).toBe(400);
    expect(base.review.execute).not.toHaveBeenCalled();
    expect(diagnostics).not.toHaveBeenCalled();
  });

  it("throttles OIDC initiation before transaction creation and recovers by source/window", async () => {
    const base = harness(["feedback.review"]);
    let now = 1;
    const origin = await listen({
      ...base.options,
      loginLimiter: new MaintainerLoginLimiter(
        { perSource: 1, global: 2, windowMs: 60_000, concurrency: 1 },
        () => now,
      ),
      proxy: { family: "x-forwarded-for", trustedCidrs: ["127.0.0.0/8"], maxHops: 2 },
    });
    const login = (source: string): Promise<Response> =>
      fetch(`${origin}/v1/maintainer/auth/login`, {
        redirect: "manual",
        headers: { "X-Forwarded-For": source },
      });
    expect((await login("192.0.2.1")).status).toBe(302);
    const sameSource = await login("192.0.2.1");
    expect(sameSource.status).toBe(429);
    expect(sameSource.headers.get("retry-after")).toBe("60");
    expect((await login("192.0.2.2")).status).toBe(302);
    expect((await login("192.0.2.3")).status).toBe(429);
    expect(base.auth.login).toHaveBeenCalledTimes(2);
    now += 60_001;
    expect((await login("192.0.2.1")).status).toBe(302);
    expect(base.auth.login).toHaveBeenCalledTimes(3);
  });

  it("passes private access only when the security capability is present", async () => {
    const { options, query, review } = harness([
      "feedback.review",
      "feedback.security",
      "feedback.audit",
    ]);
    const origin = await listen(options);
    await fetch(`${origin}/v1/maintainer/reviews`, { headers: sessionHeaders() });
    await fetch(`${origin}/v1/maintainer/reviews/${ITEM}`, { headers: sessionHeaders() });
    await fetch(`${origin}/v1/maintainer/audit`, { headers: sessionHeaders() });
    expect(query.list).toHaveBeenCalledWith(expect.objectContaining({ includePrivate: true }));
    expect(query.detail).toHaveBeenCalledWith(ITEM, true);
    expect(query.audit).toHaveBeenCalledWith(50, true);

    const response = await fetch(`${origin}/v1/maintainer/reviews/${ITEM}/actions`, {
      method: "POST",
      headers: sessionHeaders({
        "Content-Type": "application/json",
        Origin: "https://maintainer.example",
        "keiko-feedback-csrf": maintainerCsrfToken(CAPABILITY),
      }),
      body: JSON.stringify({
        action: "route-private-security",
        expectedVersion: 1,
        expectedPayloadDigest: "a".repeat(64),
        idempotencyKey: "idempotency-key-2",
      }),
    });
    expect(response.status).toBe(200);
    expect(review.execute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "route-private-security" }),
      true,
    );
  });

  it.each([
    ["review-only", ["feedback.review"], 200, 200, 200, 403, 403, 403],
    ["security-only", ["feedback.security"], 403, 403, 403, 200, 403, 403],
    ["review-and-security", ["feedback.review", "feedback.security"], 200, 200, 200, 200, 403, 403],
    ["legal-hold-only", ["feedback.legal-hold"], 403, 403, 403, 403, 200, 403],
    ["audit-only", ["feedback.audit"], 403, 403, 403, 403, 403, 200],
    ["publish-only", ["feedback.publish"], 403, 403, 403, 403, 403, 403],
  ] as const)(
    "enforces the route capability matrix for %s",
    async (_name, permissions, list, detail, archive, privateRoute, hold, audit) => {
      const { options } = harness(permissions);
      const origin = await listen(options);
      const get = sessionHeaders();
      const post = sessionHeaders({
        "Content-Type": "application/json",
        Origin: "https://maintainer.example",
        "keiko-feedback-csrf": maintainerCsrfToken(CAPABILITY),
      });
      const common = {
        expectedVersion: 1,
        expectedPayloadDigest: "a".repeat(64),
        idempotencyKey: "matrix-command-key",
      };
      const action = async (body: unknown): Promise<number> =>
        (
          await fetch(`${origin}/v1/maintainer/reviews/${ITEM}/actions`, {
            method: "POST",
            headers: post,
            body: JSON.stringify(body),
          })
        ).status;
      expect((await fetch(`${origin}/v1/maintainer/reviews`, { headers: get })).status).toBe(list);
      expect(
        (await fetch(`${origin}/v1/maintainer/reviews/${ITEM}`, { headers: get })).status,
      ).toBe(detail);
      await expect(action({ ...common, action: "archive" })).resolves.toBe(archive);
      await expect(action({ ...common, action: "route-private-security" })).resolves.toBe(
        privateRoute,
      );
      await expect(
        action({
          ...common,
          action: "place-legal-hold",
          policyKey: "policy-1",
          reviewAt: "2026-07-12T12:00:00.000Z",
          expiresAt: "2026-07-13T12:00:00.000Z",
        }),
      ).resolves.toBe(hold);
      expect((await fetch(`${origin}/v1/maintainer/audit`, { headers: get })).status).toBe(audit);
      await expect(action({ ...common, action: "approve" })).resolves.toBe(400);
      await expect(action({ ...common, action: "expire" })).resolves.toBe(400);
    },
  );

  it("rejects unauthenticated review, action, audit, and publish surfaces", async () => {
    const { options } = harness(["feedback.review", "feedback.security", "feedback.audit"]);
    const origin = await listen(options);
    for (const path of [
      "/v1/maintainer/reviews",
      `/v1/maintainer/reviews/${ITEM}`,
      `/v1/maintainer/reviews/${ITEM}/actions`,
      "/v1/maintainer/audit",
      "/v1/maintainer/publish",
    ]) {
      expect((await fetch(`${origin}${path}`)).status).toBe(401);
    }
  });

  it.each([
    ["review-only", ["feedback.review"]],
    ["publish-only", ["feedback.publish"]],
    ["neither", []],
  ] as const)(
    "requires review and publish for every publication route: %s",
    async (_name, permissions) => {
      const base = harness(permissions);
      const publication = publicationMocks();
      const origin = await listen({ ...base.options, publication });
      for (const path of [
        "prepare",
        `preview?preparationId=${ITEM}`,
        "approve",
        "cancel-route-private",
        "status",
      ]) {
        expect(
          (
            await fetch(`${origin}/v1/maintainer/reviews/${ITEM}/publication/${path}`, {
              method: path.startsWith("preview") || path === "status" ? "GET" : "POST",
              headers: sessionHeaders(),
            })
          ).status,
        ).toBe(403);
      }
      expect(publication.query.status).not.toHaveBeenCalled();
      expect(publication.repository.prepare).not.toHaveBeenCalled();
    },
  );

  it("injects canonical item, current digest, and authenticated actor into preparation", async () => {
    const base = harness(["feedback.review", "feedback.publish"]);
    const publication = publicationMocks();
    const origin = await listen({ ...base.options, publication });
    const response = await fetch(`${origin}/v1/maintainer/reviews/${ITEM}/publication/prepare`, {
      method: "POST",
      headers: publicationHeaders(),
      body: JSON.stringify({
        action: "prepare-publication",
        expectedVersion: 7,
        targetKey: "public-feedback",
        idempotencyKey: "prepare-http-key",
      }),
    });
    expect(response.status).toBe(200);
    expect(publication.repository.prepare).toHaveBeenCalledWith({
      action: "prepare-publication",
      itemId: ITEM,
      expectedVersion: 7,
      expectedPayloadDigest: "a".repeat(64),
      targetKey: "public-feedback",
      idempotencyKey: "prepare-http-key",
      actor: {
        issuer: "https://idp.example/tenant/",
        subject: "maintainer-1",
        permissionPolicyVersion: "policy-v1",
      },
    });
  });

  it("rejects publication CSRF, parser, duplicate-key, and malformed UTF-8 failures", async () => {
    const base = harness(["feedback.review", "feedback.publish"]);
    const publication = publicationMocks();
    const origin = await listen({ ...base.options, publication });
    const path = `/v1/maintainer/reviews/${ITEM}/publication/prepare`;
    const valid = JSON.stringify({
      action: "prepare-publication",
      expectedVersion: 1,
      targetKey: "public-feedback",
      idempotencyKey: "strict-parser-key",
    });
    expect(await rawStatus(origin, path, sessionHeaders(), "POST", valid)).toBe(403);
    expect(
      await rawStatus(
        origin,
        path,
        publicationHeaders(),
        "POST",
        valid.replace("}", ',"itemId":"x"}'),
      ),
    ).toBe(400);
    const duplicate = valid.replace(
      '"expectedVersion":1',
      '"expectedVersion":1,"expectedVersion":1',
    );
    expect(await rawStatus(origin, path, publicationHeaders(), "POST", duplicate)).toBe(400);
    expect(
      await rawStatus(
        origin,
        path,
        publicationHeaders(),
        "POST",
        Buffer.from([0x7b, 0xc3, 0x28, 0x7d]),
      ),
    ).toBe(400);
    expect(publication.repository.prepare).not.toHaveBeenCalled();
  });

  it("serves exact preview/latest status and injects approval CAS without content fields", async () => {
    const base = harness(["feedback.review", "feedback.publish"]);
    const publication = publicationMocks();
    const origin = await listen({ ...base.options, publication });
    const prefix = `${origin}/v1/maintainer/reviews/${ITEM}/publication`;
    const preview = await fetch(`${prefix}/preview?preparationId=${ITEM}`, {
      headers: sessionHeaders(),
    });
    expect(await preview.json()).toEqual(
      expect.objectContaining({ title: "exact <script>", body: "exact & body" }),
    );
    expect(publication.query.preview).toHaveBeenCalledWith(ITEM, ITEM, false);
    const status = await fetch(`${prefix}/status`, { headers: sessionHeaders() });
    const statusValue = (await status.json()) as Record<string, unknown>;
    expect(statusValue).not.toHaveProperty("title");
    expect(statusValue).not.toHaveProperty("body");
    expect(statusValue).not.toHaveProperty("reconciliationMarker");
    expect(publication.query.status).toHaveBeenCalledWith(ITEM, undefined, false);
    const approve = await fetch(`${prefix}/approve`, {
      method: "POST",
      headers: publicationHeaders(),
      body: JSON.stringify({
        action: "approve-publication",
        preparationId: ITEM,
        expectedProjectionDigest: "b".repeat(64),
        expectedTargetPolicyDigest: "c".repeat(64),
        idempotencyKey: "approve-http-key",
      }),
    });
    expect(approve.status).toBe(200);
    expect(publication.repository.approve).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: ITEM,
        expectedVersion: 7,
        expectedPayloadDigest: "a".repeat(64),
      }),
    );
  });

  it("maps an exactly expired cancellation to the safe domain response", async () => {
    const base = harness(["feedback.review", "feedback.publish"]);
    const publication = publicationMocks();
    publication.repository.cancelAndRoutePrivate.mockRejectedValueOnce(
      new FeedbackPublicationError("payload-expired"),
    );
    const origin = await listen({ ...base.options, publication });
    const response = await fetch(
      `${origin}/v1/maintainer/reviews/${ITEM}/publication/cancel-route-private`,
      {
        method: "POST",
        headers: publicationHeaders(),
        body: JSON.stringify({
          action: "cancel-publication-route-private",
          preparationId: ITEM,
          expectedProjectionDigest: "b".repeat(64),
          expectedTargetPolicyDigest: "c".repeat(64),
          idempotencyKey: "cancel-expired-key",
        }),
      },
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "invalid-domain" });
  });

  it.each([
    [["feedback.review"], ["feedback.review"]],
    [["feedback.publish"], []],
    [["feedback.review", "feedback.publish"], ["feedback.review"]],
    [[], []],
  ] as const)("hides disabled publication for permission set %j", async (permissions, visible) => {
    const base = harness(permissions);
    const origin = await listen(base.options);
    const session = await fetch(`${origin}/v1/maintainer/auth/session`, {
      headers: sessionHeaders(),
    });
    expect(await session.json()).toMatchObject({ permissions: visible });
    const status = await fetch(`${origin}/v1/maintainer/reviews/${ITEM}/publication/status`, {
      headers: sessionHeaders(),
    });
    expect(status.status).toBe(404);
  });
});

function publicationHeaders(): Record<string, string> {
  return sessionHeaders({
    "Content-Type": "application/json",
    Origin: "https://maintainer.example",
    "keiko-feedback-csrf": maintainerCsrfToken(CAPABILITY),
  });
}

function publicationMocks() {
  return {
    query: {
      commandContext: vi.fn().mockResolvedValue({
        version: 7,
        payloadDigest: "a".repeat(64),
        sourceVersion: 7,
        projectionDigest: "b".repeat(64),
        targetPolicyDigest: "c".repeat(64),
      }),
      preview: vi.fn().mockResolvedValue({
        status: "prepared",
        itemId: ITEM,
        preparationId: ITEM,
        projectionDigest: "b".repeat(64),
        targetPolicyDigest: "c".repeat(64),
        title: "exact <script>",
        body: "exact & body",
        targetDisplay: {
          owner: "owner",
          repository: "repository",
          labels: ["feedback"],
          labelPolicyVersion: "labels-v1",
          targetPolicyVersion: "target-v1",
        },
        expiresAt: AT.toISOString(),
      }),
      status: vi.fn().mockResolvedValue({
        itemId: ITEM,
        preparationId: ITEM,
        projectionDigest: "b".repeat(64),
        targetPolicyDigest: "c".repeat(64),
        status: "approved",
      }),
    },
    repository: {
      prepare: vi.fn().mockResolvedValue({ status: "prepared" }),
      approve: vi.fn().mockResolvedValue({ status: "approved" }),
      cancelAndRoutePrivate: vi.fn().mockResolvedValue({ status: "cancelled-private" }),
    },
  };
}
