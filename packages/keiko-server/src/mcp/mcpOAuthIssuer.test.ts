import { describe, expect, it } from "vitest";
import type { ServerLogEvent, ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { mcpOAuthMetadataUrls, validateMcpOAuthIssuer } from "./mcpOAuthIssuer.js";

const ISSUER = "https://login.example.test/tenant";
const RFC8414 = "https://login.example.test/.well-known/oauth-authorization-server/tenant";
const OIDC = "https://login.example.test/tenant/.well-known/openid-configuration";

const METADATA = {
  issuer: ISSUER,
  authorization_endpoint: "https://login.example.test/tenant/authorize",
  token_endpoint: "https://login.example.test/tenant/token",
  registration_endpoint: "https://login.example.test/tenant/register",
  code_challenge_methods_supported: ["S256"],
  response_types_supported: ["code"],
};

function serving(documents: Readonly<Record<string, unknown>>): {
  readonly fetchImpl: typeof fetch;
  readonly requested: string[];
} {
  const requested: string[] = [];
  const fetchImpl = ((input: string | URL | Request): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    requested.push(url);
    const document = documents[url];
    if (document === undefined) return Promise.resolve(new Response("missing", { status: 404 }));
    if (document instanceof Error) return Promise.reject(document);
    const body = typeof document === "string" ? document : JSON.stringify(document);
    return Promise.resolve(new Response(body, { status: 200 }));
  }) as typeof fetch;
  return { fetchImpl, requested };
}

async function validate(
  documents: Readonly<Record<string, unknown>>,
  oauth: { readonly issuer: string; readonly clientId?: string } = { issuer: ISSUER },
): Promise<{
  readonly result: Awaited<ReturnType<typeof validateMcpOAuthIssuer>>;
  readonly records: ServerLogEvent[];
  readonly requested: string[];
}> {
  const records: ServerLogEvent[] = [];
  const sink: ServerLogSink = { write: (event) => void records.push(event) };
  const { fetchImpl, requested } = serving(documents);
  const result = await validateMcpOAuthIssuer("tracker", oauth, {
    egress: undefined,
    activityLog: sink,
    correlationId: "run-oauth-1",
    fetchImpl,
  });
  return { result, records, requested };
}

function lines(records: readonly ServerLogEvent[]): readonly Readonly<Record<string, unknown>>[] {
  return records.map((record) =>
    expectActivityLogProof(
      "mcp.oauth.issuer.checked.emitted-line",
      formatActivityLogProofLine(record),
    ),
  );
}

describe("validating an MCP server's expected OAuth issuer (#3903 AC3)", () => {
  it("derives the RFC 8414 location first and the OpenID Connect one second", () => {
    expect(mcpOAuthMetadataUrls(ISSUER)).toEqual([RFC8414, OIDC]);
    expect(mcpOAuthMetadataUrls("https://login.example.test")).toEqual([
      "https://login.example.test/.well-known/oauth-authorization-server",
      "https://login.example.test/.well-known/openid-configuration",
    ]);
  });

  it("accepts the issuer's own document and pins the location it came from", async () => {
    const { result, records, requested } = await validate({ [RFC8414]: METADATA });
    expect(result).toEqual({
      ok: true,
      metadataUrl: RFC8414,
      authorizationEndpoint: METADATA.authorization_endpoint,
    });
    expect(requested).toEqual([RFC8414]);
    const [line] = lines(records);
    expect(line).toMatchObject({ candidate: 0, outcome: "validated", httpStatus: 200 });
    expect(JSON.stringify(records)).not.toContain("login.example.test");
    expect(JSON.stringify(records)).not.toContain("tracker");
  });

  it("falls back to the OpenID Connect location when the RFC 8414 one is absent", async () => {
    const { result, records } = await validate({ [OIDC]: METADATA });
    expect(result).toMatchObject({ ok: true, metadataUrl: OIDC });
    expect(lines(records).map((line) => line.outcome)).toEqual(["not-found", "validated"]);
  });

  it.each([
    [
      "names another issuer",
      { ...METADATA, issuer: "https://evil.example.test" },
      "issuer-mismatch",
    ],
    [
      "names the issuer with a trailing slash",
      { ...METADATA, issuer: `${ISSUER}/` },
      "issuer-mismatch",
    ],
    [
      "authorizes over http",
      { ...METADATA, authorization_endpoint: "http://login.example.test/authorize" },
      "insecure-endpoint",
    ],
    [
      "registers over http",
      { ...METADATA, registration_endpoint: "http://login.example.test/register" },
      "insecure-endpoint",
    ],
    ["has no token endpoint", { ...METADATA, token_endpoint: undefined }, "insecure-endpoint"],
    [
      "offers no PKCE S256",
      { ...METADATA, code_challenge_methods_supported: ["plain"] },
      "pkce-unsupported",
    ],
    [
      "omits PKCE methods",
      { ...METADATA, code_challenge_methods_supported: undefined },
      "pkce-unsupported",
    ],
    [
      "offers no code flow",
      { ...METADATA, response_types_supported: ["token"] },
      "metadata-invalid",
    ],
    [
      "cannot register a client the operator did not name",
      { ...METADATA, registration_endpoint: undefined },
      "registration-unavailable",
    ],
  ])("refuses a document that %s", async (_label, document, reason) => {
    const { result, records } = await validate({ [RFC8414]: document, [OIDC]: document });
    expect(result).toEqual({ ok: false, reason });
    expect(lines(records).map((line) => line.outcome)).toEqual([reason, reason]);
    expect(records.every((record) => record.level === "warn")).toBe(true);
  });

  it("accepts a document without registration when the operator names its own client", async () => {
    const document = { ...METADATA, registration_endpoint: undefined };
    const { result } = await validate(
      { [RFC8414]: document },
      { issuer: ISSUER, clientId: "keiko" },
    );
    expect(result).toMatchObject({ ok: true });
  });

  it("admits nothing when no location answers with a bounded JSON object", async () => {
    const { result, records } = await validate({
      [RFC8414]: "not json",
      [OIDC]: new TypeError("fetch failed"),
    });
    expect(result).toEqual({ ok: false, reason: "metadata-unavailable" });
    const [first, second] = lines(records);
    expect(first).toMatchObject({ candidate: 0, outcome: "unreadable" });
    expect(second).toMatchObject({ candidate: 1, outcome: "unreadable" });
    expect(second?.frames).toEqual(expect.any(Array));
    expect(records[1]?.errorKind).toBe("read-failed");
  });

  it("never reads a document from a loopback issuer", async () => {
    const { result, requested } = await validate(
      {
        "https://127.0.0.1/.well-known/oauth-authorization-server": {
          ...METADATA,
          issuer: "https://127.0.0.1",
        },
      },
      { issuer: "https://127.0.0.1" },
    );
    expect(result).toEqual({ ok: false, reason: "metadata-unavailable" });
    expect(requested).toEqual([]);
  });
});
