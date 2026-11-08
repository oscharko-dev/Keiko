import { describe, expect, it, vi } from "vitest";
import {
  AtlassianCredentialCustodyError,
  type AtlassianHttpBodyRequest,
} from "@oscharko-dev/keiko-connectors";
import { createGatewayAtlassianHttpBodyPort } from "./httpPort.js";

const BASE = "https://jira.example.invalid/context";
const AUTH = `atlassian-cred:${"Cc3-_".repeat(4)}Xx`;
const COOKIE = "JSESSIONID=synthetic-session";
const BYTES = new Uint8Array([0x89, 0x50, 0xff, 0x00]);
const UPLOAD: AtlassianHttpBodyRequest = {
  method: "POST",
  url: `${BASE}/rest/api/2/project/7/avatar/temporary?filename=synthetic.png&size=4`,
  timeoutMs: 1000,
  maxBodyBytes: 4096,
  jiraAvatarImage: true,
  upload: { contentType: "image/png", bytes: BYTES },
};
function fixture(): {
  cookie: import("vitest").Mock<() => string>;
  credential: import("vitest").Mock<() => never>;
  beforeDispatch: import("vitest").Mock<() => boolean>;
  fetchImpl: import("vitest").Mock<typeof fetch>;
  options: {
    baseUrl: string;
    authRef: string;
    credentials: { resolveForExecution: import("vitest").Mock<() => never> };
    beforeDispatch: import("vitest").Mock<() => boolean>;
    fetchImpl: import("vitest").Mock<typeof fetch>;
    privateAuthentication: {
      kind: "session";
      scope: "avatar";
      cookie: import("vitest").Mock<() => string>;
    };
  };
  port: import("@oscharko-dev/keiko-connectors").AtlassianHttpBodyPort;
} {
  const cookie = vi.fn(() => COOKIE);
  const credential = vi.fn(() => {
    throw new TypeError("A cookie-only request cannot resolve PAT material");
  });
  const beforeDispatch = vi.fn(() => true);
  const fetchImpl = vi.fn<typeof fetch>(() =>
    Promise.resolve(
      Response.json({
        cropperOffsetX: 0,
        cropperOffsetY: 0,
        cropperWidth: 1,
        needsCropping: false,
      }),
    ),
  );
  const options = {
    baseUrl: BASE,
    authRef: AUTH,
    credentials: { resolveForExecution: credential },
    beforeDispatch,
    fetchImpl,
    privateAuthentication: { kind: "session" as const, scope: "avatar" as const, cookie },
  };
  return {
    cookie,
    credential,
    beforeDispatch,
    fetchImpl,
    options,
    port: createGatewayAtlassianHttpBodyPort(options),
  };
}
describe("fixed private avatar/session HTTP scope", () => {
  it("copies arbitrary image bytes before awaits and sends raw native media with cookie-only authentication", async () => {
    const f = fixture();
    const bytes = new Uint8Array(BYTES);
    f.beforeDispatch.mockImplementation(() => {
      bytes.fill(0);
      return true;
    });
    expect(await f.port({ ...UPLOAD, upload: { contentType: "image/png", bytes } })).toMatchObject({
      status: 200,
    });
    const init = f.fetchImpl.mock.calls[0]?.[1];
    expect(init?.body).toEqual(BYTES);
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("image/png");
    expect(headers.get("cookie")).toBe(COOKIE);
    expect(headers.get("x-atlassian-token")).toBe("no-check");
    expect(headers.has("authorization")).toBe(false);
    expect(f.credential).not.toHaveBeenCalled();
    expect(f.cookie).toHaveBeenCalledOnce();
  });
  it.each([
    { url: `${BASE}/rest/api/2/project/7/avatar/temporary?filename=synthetic.png&size=5` },
    {
      url: `${BASE}/rest/api/2/project/7/avatar/temporary?filename=synthetic.png&size=4&other=true`,
    },
    {
      url: "https://jira.example.invalid/other/rest/api/2/project/7/avatar/temporary?filename=synthetic.png&size=4",
    },
    { url: `${BASE}/rest/api/2/avatar/project/temporary?filename=synthetic.png&size=4` },
    { upload: { contentType: "image/svg+xml", bytes: BYTES } },
    { jiraAvatarImage: undefined },
    { jiraUserColumns: true },
    { bodyJson: "{}" },
    { method: "PUT" },
  ] satisfies readonly Partial<AtlassianHttpBodyRequest>[])(
    "refuses unsupported image route/query/media/flag before native dispatch %#",
    async (delta) => {
      const f = fixture();
      await expect(f.port({ ...UPLOAD, ...delta })).rejects.toBeInstanceOf(
        AtlassianCredentialCustodyError,
      );
      expect(f.beforeDispatch).not.toHaveBeenCalled();
      expect(f.cookie).not.toHaveBeenCalled();
      expect(f.fetchImpl).not.toHaveBeenCalled();
    },
  );
  it("never falls back to PAT when the private session disappears before dispatch", async () => {
    const f = fixture();
    f.cookie.mockImplementation(() => {
      throw new AtlassianCredentialCustodyError("credential-changed");
    });
    await expect(f.port(UPLOAD)).rejects.toBeInstanceOf(AtlassianCredentialCustodyError);
    expect(f.credential).not.toHaveBeenCalled();
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it("never retries a temporary upload after a lost ACK", async () => {
    const f = fixture();
    f.fetchImpl.mockRejectedValue(new TypeError("Synthetic lost upload response"));
    expect(await f.port(UPLOAD)).toMatchObject({ kind: "network-error" });
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(f.cookie).toHaveBeenCalledOnce();
  });
  it("drops cookie-session error diagnostics after recording the actual native status", async () => {
    const f = fixture();
    const onResponse = vi.fn(() => true);
    f.fetchImpl.mockResolvedValue(
      Response.json({ errorMessages: [`Session ${COOKIE} refused`] }, { status: 403 }),
    );
    const port = createGatewayAtlassianHttpBodyPort({ ...f.options, onResponse });
    const result = await port(UPLOAD);
    expect(result).toMatchObject({ kind: "response", status: 403, bodyText: "" });
    expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({ method: "POST" }), 403);
    expect(JSON.stringify(result)).not.toContain("synthetic-session");
    expect(f.fetchImpl).toHaveBeenCalledOnce();
  });
  it.each([false, true])(
    "refuses successful reflection of private cookie material without losing its ACK (escaped=%s)",
    async (escaped) => {
      const f = fixture();
      const onResponse = vi.fn(() => true);
      const value = "synthetic-session";
      const spelling = escaped
        ? Array.from(value)
            .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
            .join("")
        : value;
      f.fetchImpl.mockResolvedValue(
        new Response(`{"id":"41","owner":"${spelling}"}`, { status: 201 }),
      );
      const port = createGatewayAtlassianHttpBodyPort({ ...f.options, onResponse });
      const result = await port(UPLOAD);
      expect(result).toMatchObject({
        kind: "response",
        status: 201,
        bodyText: "",
        truncated: true,
      });
      expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({ method: "POST" }), 201);
      expect(JSON.stringify(result)).not.toContain(value);
      expect(JSON.stringify(result)).not.toContain(spelling);
      expect(f.fetchImpl).toHaveBeenCalledOnce();
      expect(f.credential).not.toHaveBeenCalled();
    },
  );
});
