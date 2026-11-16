import { once } from "node:events";
import { createServer } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import { describe, expect, it, vi, type Mock } from "vitest";
import {
  AtlassianCredentialCustodyError,
  type AtlassianCredentialExecutionResolver,
  type AtlassianHttpBodyRequest,
  type AtlassianResolvedCredential,
} from "@oscharko-dev/keiko-connectors";
import { createGatewayAtlassianHttpBodyPort, createGatewayAtlassianHttpPort } from "./httpPort.js";
import type { AtlassianTargetAdmission } from "./targetAdmission.js";

const AUTH_REF = `atlassian-cred:${"Cc3-_".repeat(4)}Xx`;
const CREDENTIAL: AtlassianResolvedCredential = {
  scheme: "bearer-pat",
  apiToken: ["synthetic", "private", "admission", "fixture"].join("-"),
};
const PRIVATE_BASE = "https://10.23.45.67:8443/jira";
const PORTS = [
  ["status", createGatewayAtlassianHttpPort],
  ["body", createGatewayAtlassianHttpBodyPort],
] as const;

interface PortFixture {
  readonly credentials: AtlassianCredentialExecutionResolver;
  readonly resolveForExecution: Mock<() => AtlassianResolvedCredential>;
  readonly fetchImpl: Mock<typeof fetch>;
}

function fixture(status = 200, headers: Record<string, string> = {}): PortFixture {
  const resolveForExecution = vi.fn((): AtlassianResolvedCredential => CREDENTIAL);
  const credentials: AtlassianCredentialExecutionResolver = { resolveForExecution };
  const fetchImpl = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response("{}", { status, headers })),
  );
  return { credentials, resolveForExecution, fetchImpl };
}

function admission(
  baseUrl: string,
  addressClass: AtlassianTargetAdmission["addressClass"],
): Mock<(signal: AbortSignal) => Promise<AtlassianTargetAdmission>> {
  return vi.fn((_signal: AbortSignal): Promise<AtlassianTargetAdmission> =>
    Promise.resolve({ baseUrl, addressClass }),
  );
}

function request(baseUrl: string): AtlassianHttpBodyRequest & { readonly method: "GET" } {
  return {
    method: "GET" as const,
    url: `${baseUrl}/rest/api/2/myself`,
    timeoutMs: 1000,
    maxBodyBytes: 256,
  };
}

async function expectRefused(pending: Promise<{ readonly kind: string }>): Promise<void> {
  const outcome = await pending.then(
    (value) => ({ kind: "value" as const, value }),
    (error: unknown) => ({ kind: "error" as const, error }),
  );
  if (outcome.kind === "error") {
    expect(outcome.error).toBeInstanceOf(AtlassianCredentialCustodyError);
  } else {
    expect(outcome.value).toEqual({ kind: "network-error" });
  }
}

describe.each(PORTS)("%s port stored target admission", (_name, factory) => {
  it("retains ordinary public Cloud access without a private admission callback", async () => {
    const f = fixture();
    const baseUrl = "https://cloud.example.invalid/jira";
    expect(
      await factory({
        baseUrl,
        authRef: AUTH_REF,
        credentials: f.credentials,
        fetchImpl: f.fetchImpl,
      })(request(baseUrl)),
    ).toMatchObject({ kind: "response", status: 200 });
    expect(f.resolveForExecution).toHaveBeenCalledExactlyOnceWith(AUTH_REF);
    expect(f.fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    [PRIVATE_BASE, "private"],
    ["https://172.20.4.5:8443/jira", "private"],
    ["https://192.168.40.5:8443/jira", "private"],
    ["https://[fd12:3456::5]:8443/jira", "private"],
    ["https://127.0.0.1:18443/jira", "loopback"],
    ["https://[::1]:18443/jira", "loopback"],
    ["https://localhost:18443/jira", "loopback"],
    ["https://[::ffff:7f00:1]:18443/jira", "loopback"],
  ] as const)("admits the selected %s without a file-owned target list", async (baseUrl, kind) => {
    const f = fixture();
    const targetAdmission = admission(baseUrl, kind);
    const result = await factory({
      baseUrl,
      authRef: AUTH_REF,
      credentials: f.credentials,
      fetchImpl: f.fetchImpl,
      targetAdmission,
    })(request(baseUrl));
    expect(result).toMatchObject({ kind: "response", status: 200 });
    expect(targetAdmission).toHaveBeenCalledOnce();
    expect(targetAdmission.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    expect(f.resolveForExecution).toHaveBeenCalledExactlyOnceWith(AUTH_REF);
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = f.fetchImpl.mock.calls[0] ?? [];
    const dispatchedUrl =
      typeof url === "string" ? url : url instanceof URL ? url.toString() : url?.url;
    expect(dispatchedUrl).toBe(request(baseUrl).url);
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${CREDENTIAL.apiToken}`);
  });

  it.each([PRIVATE_BASE, "https://127.0.0.1:18443/jira", "https://[fd12:3456::5]/jira"])(
    "keeps an unadmitted Cloud target public-only: %s",
    async (baseUrl) => {
      const f = fixture();
      await expectRefused(
        factory({
          baseUrl,
          authRef: AUTH_REF,
          credentials: f.credentials,
          fetchImpl: f.fetchImpl,
          egress: () => ({ allowPrivateNetwork: true, allowLinkLocalAndMetadata: true }),
        })(request(baseUrl)),
      );
      expect(f.resolveForExecution).not.toHaveBeenCalled();
      expect(f.fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    "https://10.23.45.68:8443/jira/rest/api/2/myself",
    "https://10.23.45.67:8444/jira/rest/api/2/myself",
    "http://10.23.45.67:8443/jira/rest/api/2/myself",
    "https://10.23.45.67:8443/jira-other/rest/api/2/myself",
    "https://10.23.45.67:8443/admin",
    "https://10.23.45.67:8443/jira/%2fadmin",
    "https://10.23.45.67:8443/jira/%252e%252e/admin",
    "https://10.23.45.67:8443/jira/rest/api/2/myself#fragment",
    "https://user:synthetic@10.23.45.67:8443/jira/rest/api/2/myself",
  ])("rejects request escape before reading admission or credentials: %s", async (url) => {
    const f = fixture();
    const targetAdmission = admission(PRIVATE_BASE, "private");
    await expect(
      factory({
        baseUrl: PRIVATE_BASE,
        authRef: AUTH_REF,
        credentials: f.credentials,
        fetchImpl: f.fetchImpl,
        targetAdmission,
      })({ ...request(PRIVATE_BASE), url }),
    ).rejects.toBeInstanceOf(AtlassianCredentialCustodyError);
    expect(targetAdmission).not.toHaveBeenCalled();
    expect(f.resolveForExecution).not.toHaveBeenCalled();
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { baseUrl: "not-a-url", addressClass: "private" },
    { baseUrl: "https://10.23.45.68:8443/jira", addressClass: "private" },
    { baseUrl: "https://10.23.45.67:8443/other", addressClass: "private" },
    { baseUrl: PRIVATE_BASE, addressClass: "public" },
    { baseUrl: PRIVATE_BASE, addressClass: "loopback" },
    { baseUrl: PRIVATE_BASE, addressClass: "metadata" },
  ])("refuses missing, mismatched or malformed admission %# before credentials", async (value) => {
    const f = fixture();
    await expectRefused(
      factory({
        baseUrl: PRIVATE_BASE,
        authRef: AUTH_REF,
        credentials: f.credentials,
        fetchImpl: f.fetchImpl,
        targetAdmission: () => Promise.resolve(value as AtlassianTargetAdmission | undefined),
      })(request(PRIVATE_BASE)),
    );
    expect(f.resolveForExecution).not.toHaveBeenCalled();
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    "https://0.0.0.0:1983/jira",
    "https://[::]:1983/jira",
    "https://[::ffff:0:0]:1983/jira",
    "https://[::ffff:7f00:1]:1983/jira",
    "https://[::ffff:a9fe:a9fe]/jira",
    "https://[::ffff:a9fe:1]/jira",
    "https://169.254.169.254/jira",
    "https://169.254.20.5/jira",
    "https://[fe80::5]/jira",
    "https://[64:ff9b::a9fe:a9fe]/jira",
  ])("keeps unsafe classes blocked despite a private admission claim: %s", async (baseUrl) => {
    const f = fixture();
    await expectRefused(
      factory({
        baseUrl,
        authRef: AUTH_REF,
        credentials: f.credentials,
        fetchImpl: f.fetchImpl,
        targetAdmission: admission(baseUrl, "private"),
        egress: () => ({ allowPrivateNetwork: true, allowLinkLocalAndMetadata: true }),
      })(request(baseUrl)),
    );
    expect(f.resolveForExecution).not.toHaveBeenCalled();
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    "https://127.0.0.1:1983/jira",
    "https://[::1]:1983/jira",
    "https://localhost:1983/jira",
  ])(
    "refuses a registered BFF listener despite explicit loopback admission: %s",
    async (baseUrl) => {
      const f = fixture();
      await expectRefused(
        factory({
          baseUrl,
          authRef: AUTH_REF,
          credentials: f.credentials,
          fetchImpl: f.fetchImpl,
          targetAdmission: admission(baseUrl, "loopback"),
          deniedLoopbackPorts: () => [1983],
        })(request(baseUrl)),
      );
      expect(f.resolveForExecution).not.toHaveBeenCalled();
      expect(f.fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("rechecks the selected admission on each request and stops after revocation", async () => {
    const f = fixture();
    let current: AtlassianTargetAdmission | undefined = {
      baseUrl: PRIVATE_BASE,
      addressClass: "private",
    };
    const targetAdmission = vi.fn(() => Promise.resolve(current));
    const port = factory({
      baseUrl: PRIVATE_BASE,
      authRef: AUTH_REF,
      credentials: f.credentials,
      fetchImpl: f.fetchImpl,
      targetAdmission,
    });
    expect(await port(request(PRIVATE_BASE))).toMatchObject({ kind: "response", status: 200 });
    current = undefined;
    await expectRefused(port(request(PRIVATE_BASE)));
    expect(targetAdmission).toHaveBeenCalledTimes(2);
    expect(f.resolveForExecution).toHaveBeenCalledOnce();
    expect(f.fetchImpl).toHaveBeenCalledOnce();
  });

  it("surfaces a redirect without dispatching to its foreign destination", async () => {
    const f = fixture(302, { location: "https://foreign.example.invalid/redirect" });
    const result = await factory({
      baseUrl: PRIVATE_BASE,
      authRef: AUTH_REF,
      credentials: f.credentials,
      fetchImpl: f.fetchImpl,
      targetAdmission: admission(PRIVATE_BASE, "private"),
    })(request(PRIVATE_BASE));
    expect(result).toMatchObject({ kind: "response", status: 302 });
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(f.fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("keeps certificate failures fatal for an admitted private connection", async () => {
    const f = fixture();
    f.fetchImpl.mockRejectedValue(
      Object.assign(new Error("synthetic certificate failure"), { code: "CERT_HAS_EXPIRED" }),
    );
    expect(
      await factory({
        baseUrl: PRIVATE_BASE,
        authRef: AUTH_REF,
        credentials: f.credentials,
        fetchImpl: f.fetchImpl,
        targetAdmission: admission(PRIVATE_BASE, "private"),
      })(request(PRIVATE_BASE)),
    ).toEqual({ kind: "network-error", reason: "tls" });
    expect(f.fetchImpl).toHaveBeenCalledOnce();
  });
});

const DNS_CASES = [
  { label: "mixed private/public", kind: "private", addresses: ["10.23.45.67", "203.0.113.10"] },
  { label: "private to public switch", kind: "private", addresses: ["203.0.113.10"] },
  { label: "public to private switch", kind: "public", addresses: ["10.23.45.67"] },
  { label: "metadata answer", kind: "private", addresses: ["169.254.169.254"] },
  { label: "link-local answer", kind: "private", addresses: ["169.254.20.5"] },
  { label: "self BFF answer", kind: "private", addresses: ["127.0.0.1"] },
  { label: "unspecified IPv4", kind: "private", addresses: ["0.0.0.0"] },
  { label: "unspecified IPv6", kind: "private", addresses: ["::"] },
  { label: "expanded unspecified IPv6", kind: "public", addresses: ["0:0:0:0:0:0:0:0"] },
  { label: "expanded loopback IPv6", kind: "public", addresses: ["0:0:0:0:0:0:0:1"] },
  { label: "mapped unspecified IPv4", kind: "private", addresses: ["::ffff:0:0"] },
  { label: "mapped self BFF", kind: "private", addresses: ["::ffff:7f00:1"] },
  { label: "mapped metadata", kind: "private", addresses: ["::ffff:a9fe:a9fe"] },
  { label: "mapped link local", kind: "private", addresses: ["::ffff:a9fe:1"] },
] as const;

describe.each(["status", "body"] as const)("%s port admission DNS binding", (name) => {
  it.each(DNS_CASES)("refuses $label before credentials or proxy contact", async (entry) => {
    const proxy = createServer();
    let proxyContacts = 0;
    proxy.on("connect", (_request, socket) => {
      proxyContacts += 1;
      socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as AddressInfo).port;
    const baseUrl = "https://jira.admission.test:8443/context";
    const f = fixture();
    const lookup = vi.fn(() =>
      Promise.resolve(entry.addresses.map((address) => ({ address, family: isIP(address) }))),
    );
    try {
      vi.resetModules();
      vi.doMock("node:dns/promises", () => ({ lookup }));
      const fresh = await import("./httpPort.js");
      const factory =
        name === "status"
          ? fresh.createGatewayAtlassianHttpPort
          : fresh.createGatewayAtlassianHttpBodyPort;
      await expectRefused(
        factory({
          baseUrl,
          authRef: AUTH_REF,
          credentials: f.credentials,
          targetAdmission: admission(baseUrl, entry.kind),
          deniedLoopbackPorts: () => [8443],
          egress: () => ({ httpsProxy: `http://127.0.0.1:${String(proxyPort)}` }),
        })(request(baseUrl)),
      );
      expect(lookup).toHaveBeenCalledWith(
        "jira.admission.test",
        expect.objectContaining({ all: true }),
      );
      expect(f.resolveForExecution).not.toHaveBeenCalled();
      expect(proxyContacts).toBe(0);
    } finally {
      vi.doUnmock("node:dns/promises");
      vi.resetModules();
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => {
        proxy.close(() => {
          resolve();
        });
      });
    }
  });
});
