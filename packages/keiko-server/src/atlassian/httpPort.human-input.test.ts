import { describe, expect, it, vi } from "vitest";
import {
  AtlassianCredentialCustodyError,
  JiraHumanInputCustodyError,
  type AtlassianHttpBodyRequest,
  type JiraHumanInputSelection,
  type JiraHumanInputValues,
} from "@oscharko-dev/keiko-connectors";
import { createGatewayAtlassianHttpBodyPort } from "./httpPort.js";

const BASE = "https://jira.example.invalid/context";
const AUTH = `atlassian-cred:${"Cc3-_".repeat(4)}Xx`;
const SECRET = ["synthetic", "human only", "value"].join("\n");
const selection: JiraHumanInputSelection = {
  requestId: `jhi_${"a".repeat(64)}`,
  revision: "7765d9e4-fc9a-46d5-aea4-24880fec5e1e",
  binding: {
    context: {
      kind: "chat",
      chatId: "chat",
      messageId: "message",
      callId: "call",
      podId: "7765d9e4-fc9a-46d5-aea4-24880fec5e1e",
      bindingGeneration: 1,
    },
    authority: { runId: "run", envelopeDigest: "d".repeat(64) },
    authRef: AUTH,
    principalDigest: "b".repeat(64),
    authenticationGeneration: 1,
    verificationRevision: 1,
    argumentsDigest: "c".repeat(64),
    actorUserKey: "actor-key",
    actorUsername: "Actor Name",
    expiresAt: 1_900_000_000_000,
    operation: "jira.update-my-password",
  },
};
const REQUEST: AtlassianHttpBodyRequest = {
  method: "PUT",
  url: `${BASE}/rest/api/2/myself/password`,
  timeoutMs: 1000,
  maxBodyBytes: 4096,
  jiraHumanInput: { selection, fields: {} },
};
function fixture(response: () => Response = () => new Response(null, { status: 204 })): {
  claim: import("vitest").Mock<() => JiraHumanInputValues>;
  order: string[];
  onConsumed: import("vitest").Mock<() => void>;
  port: import("@oscharko-dev/keiko-connectors").AtlassianHttpBodyPort;
  baseUrl: string;
  authRef: string;
  credentials: {
    humanInputs: { claim: import("vitest").Mock<() => JiraHumanInputValues> };
    resolveForExecution: import("vitest").Mock<() => { scheme: "bearer-pat"; apiToken: string }>;
  };
  beforeDispatch: import("vitest").Mock<() => boolean>;
  onResponse: import("vitest").Mock<() => boolean>;
  onHumanInputConsumed: import("vitest").Mock<() => void>;
  fetchImpl: import("vitest").Mock<typeof fetch>;
} {
  let consumed = false;
  const order: string[] = [];
  const claim = vi.fn((): JiraHumanInputValues => {
    if (consumed) throw new JiraHumanInputCustodyError("not-ready");
    consumed = true;
    order.push("claim");
    return { currentPassword: SECRET, password: SECRET + " next" };
  });
  const credentials = {
    humanInputs: { claim },
    resolveForExecution: vi.fn(() => {
      order.push("credential");
      return { scheme: "bearer-pat" as const, apiToken: "synthetic-pat" };
    }),
  };
  const beforeDispatch = vi.fn(() => {
    order.push("admit");
    return true;
  });
  const onConsumed = vi.fn(() => {
    order.push("consumed");
  });
  const onResponse = vi.fn(() => true);
  const fetchImpl = vi.fn<typeof fetch>(() => {
    order.push("fetch");
    return Promise.resolve(response());
  });
  const options = {
    baseUrl: BASE,
    authRef: AUTH,
    credentials,
    beforeDispatch,
    onResponse,
    onHumanInputConsumed: onConsumed,
    fetchImpl,
  };
  return {
    ...options,
    claim,
    order,
    onConsumed,
    port: createGatewayAtlassianHttpBodyPort(options),
  };
}
describe("private Jira body materialization in the existing HTTP owner", () => {
  it("claims once after admission, sends exact escaped bytes and persists no secret in request snapshots", async () => {
    const f = fixture();
    expect(await f.port(REQUEST)).toMatchObject({ status: 204 });
    expect(f.order).toEqual(["admit", "credential", "claim", "consumed", "fetch"]);
    expect(f.fetchImpl.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ currentPassword: SECRET, password: SECRET + " next" }),
    );
    expect(JSON.stringify(f.beforeDispatch.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(f.onConsumed.mock.calls)).not.toContain(SECRET);
    expect(f.onConsumed).toHaveBeenCalledWith(
      expect.objectContaining({ state: "consumed", revision: selection.revision }),
    );
    await expect(f.port(REQUEST)).rejects.toBeInstanceOf(JiraHumanInputCustodyError);
    expect(f.fetchImpl).toHaveBeenCalledOnce();
  });
  it("does not claim or materialize after local authority denial", async () => {
    const f = fixture();
    f.beforeDispatch.mockReturnValue(false);
    await expect(f.port(REQUEST)).rejects.toBeInstanceOf(AtlassianCredentialCustodyError);
    expect(f.claim).not.toHaveBeenCalled();
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    { url: `${BASE}/rest/api/2/user/password` },
    { url: "https://foreign.invalid/context/rest/api/2/myself/password" },
    { url: "https://jira.example.invalid/rest/api/2/myself/password" },
    { url: `${REQUEST.url}?other=true` },
    { method: "POST" },
    { bodyJson: "{}" },
    { jiraUserColumns: true },
    { jiraIdentityExperimental: true },
    { jiraHumanInput: { selection, fields: { password: "model supplied" } } },
  ] satisfies readonly Partial<AtlassianHttpBodyRequest>[])(
    "refuses path, method, media and model-field drift before credentials %#",
    async (delta) => {
      const f = fixture();
      await expect(f.port({ ...REQUEST, ...delta })).rejects.toBeInstanceOf(
        AtlassianCredentialCustodyError,
      );
      expect(f.beforeDispatch).not.toHaveBeenCalled();
      expect(f.claim).not.toHaveBeenCalled();
      expect(f.credentials.resolveForExecution).not.toHaveBeenCalled();
    },
  );
  it("removes reflected native error material while preserving native status before late cancellation", async () => {
    const f = fixture(
      () => new Response(JSON.stringify({ errorMessages: [SECRET] }), { status: 400 }),
    );
    const abort = new AbortController();
    f.onResponse.mockImplementation(() => {
      abort.abort();
      return true;
    });
    const result = await f.port({ ...REQUEST, signal: abort.signal });
    expect(result).toMatchObject({ kind: "response", status: 400, bodyText: "" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(f.fetchImpl).toHaveBeenCalledOnce();
  });
  it("does not retry a body that was consumed before a lost physical response", async () => {
    const f = fixture();
    f.fetchImpl.mockRejectedValue(new TypeError("Synthetic lost response"));
    expect(await f.port(REQUEST)).toMatchObject({ kind: "network-error" });
    expect(f.claim).toHaveBeenCalledOnce();
    expect(f.fetchImpl).toHaveBeenCalledOnce();
  });
  it("projects policy violations as bounded facts without their possibly reflected text", async () => {
    const f = fixture(() => new Response(JSON.stringify([SECRET])));
    const policy = {
      ...selection,
      binding: { ...selection.binding, operation: "jira.validate-update-user-password" as const },
    };
    f.claim.mockImplementation(() => ({ newPassword: SECRET }));
    const result = await f.port({
      ...REQUEST,
      method: "POST",
      url: `${BASE}/rest/api/2/password/policy/updateUser`,
      jiraHumanInput: { selection: policy, fields: { username: "Target User" } },
    });
    expect(result).toMatchObject({ bodyText: '{"accepted":false,"violationCount":1}' });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
  it("sends a native JSON license string and never exposes licenseString", async () => {
    const f = fixture(() => new Response(JSON.stringify({ errors: {}, licenseString: SECRET })));
    f.claim.mockImplementation(() => ({ license: SECRET }));
    const license = {
      ...selection,
      binding: { ...selection.binding, operation: "jira.validate-license" as const },
    };
    expect(
      await f.port({
        ...REQUEST,
        method: "POST",
        url: `${BASE}/rest/api/2/licenseValidator`,
        jiraHumanInput: { selection: license, fields: {} },
      }),
    ).toMatchObject({ bodyText: '{"accepted":true,"violationCount":0}' });
    expect(f.fetchImpl.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(SECRET));
  });
  it("claims the exact human shutdown attestation once and sends a bodyless unlock DELETE", async () => {
    const f = fixture();
    f.claim.mockReturnValue({ ownerShutdownConfirmation: "confirmed" });
    const unlock = {
      ...selection,
      binding: { ...selection.binding, operation: "jira.unlock-user-anonymization" as const },
    };
    expect(
      await f.port({
        ...REQUEST,
        method: "DELETE",
        url: `${BASE}/rest/api/2/user/anonymization/unlock`,
        jiraHumanInput: { selection: unlock, fields: {} },
      }),
    ).toMatchObject({ status: 204 });
    expect(f.claim).toHaveBeenCalledOnce();
    const init = f.fetchImpl.mock.calls[0]?.[1];
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get("content-type")).toBeNull();
    expect(JSON.stringify(init)).not.toContain("ownerShutdownConfirmation");
  });
});
