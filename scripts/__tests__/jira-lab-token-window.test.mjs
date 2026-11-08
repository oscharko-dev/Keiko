import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ensureFixtureAdminToken } from "../testing/jira-chat-lab/seed-identities.mjs";

const { native } = vi.hoisted(() => ({ native: vi.fn() }));
vi.mock("../testing/jira-chat-lab/lab-client.mjs", async (original) => ({
  ...(await original()),
  labRequest: native,
  checked: async (...args) => {
    const [session, , ...request] = args;
    return (await native(session, ...request)).value;
  },
}));
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});
function tokenResponse(state, token, method, target) {
  if (target === "/rest/pat/latest/tokens" && method === "GET")
    return { status: 200, value: structuredClone(state.tokens) };
  if (target === "/rest/pat/latest/tokens" && method === "POST") {
    if (state.failCreation) throw new TypeError("Synthetic lost response");
    const next = token(2, state.replacementSeconds);
    state.tokens.push(next);
    return { status: 201, value: { ...next, rawToken: "synthetic-new-private-token" } };
  }
  if (target === "/rest/pat/latest/tokens/1" && method === "DELETE") {
    state.tokens = state.tokens.filter((row) => row.id !== 1);
    if (state.failRetirement) throw new TypeError("Synthetic lost retirement response");
    return { status: 204 };
  }
  throw new TypeError("Unexpected synthetic token route");
}

function fixture(seconds = 60) {
  const directory = mkdtempSync(join(tmpdir(), "jira-lab-token-window-"));
  roots.push(directory);
  mkdirSync(join(directory, "secrets"), { mode: 0o700 });
  const path = join(directory, "secrets", "admin-token");
  writeFileSync(path, "synthetic-old-private-token", { mode: 0o600 });
  writeFileSync(join(directory, "secrets", "admin-password"), "synthetic-private-password", {
    mode: 0o600,
  });
  const token = (id, seconds) => ({
    id,
    name: "Keiko synthetic 4081 session",
    expiringAt: Date.now() + seconds * 1000,
  });
  const state = {
    tokens: [token(1, seconds)],
    failCreation: false,
    wrongIdentity: false,
    replacementSeconds: 86_400,
    failRetirement: false,
  };
  native.mockImplementation(async (_session, method, target, auth) => {
    if (target.startsWith("/rest/pat/latest/tokens"))
      return tokenResponse(state, token, method, target);
    if (target === "/rest/api/2/myself")
      return {
        status: 200,
        value: {
          name:
            state.wrongIdentity && auth.includes("new-private") ? "keiko-foreign" : "keiko-admin",
          active: true,
        },
      };
    if (target.startsWith("/rest/api/2/mypermissions"))
      return { status: 200, value: { permissions: { ADMINISTER: { havePermission: true } } } };
    throw new TypeError("Unexpected synthetic route");
  });
  return { session: { directory }, path, state };
}
it("renews a nearly expired owned PAT, verifies its identity and expiry, then retires only the old id", async () => {
  const f = fixture();
  await ensureFixtureAdminToken(f.session);
  expect(readFileSync(f.path, "utf8")).toBe("synthetic-new-private-token");
  expect(f.state.tokens.map((row) => row.id)).toEqual([2]);
  expect(native.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(1);
});
it("reuses a PAT with sufficient native remaining time without mutations", async () => {
  const f = fixture(7200);
  await ensureFixtureAdminToken(f.session);
  expect(readFileSync(f.path, "utf8")).toBe("synthetic-old-private-token");
  expect(native.mock.calls.some((call) => call[1] !== "GET")).toBe(false);
});
it("retains the intent after a lost creation response and never creates a second replacement", async () => {
  const f = fixture();
  f.state.failCreation = true;
  await expect(ensureFixtureAdminToken(f.session)).rejects.toThrow(TypeError);
  await expect(ensureFixtureAdminToken(f.session)).rejects.toThrow(TypeError);
  expect(native.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(1);
});
it("does not replace the credential or revoke the old token if the new identity differs", async () => {
  const f = fixture();
  f.state.wrongIdentity = true;
  await expect(ensureFixtureAdminToken(f.session)).rejects.toThrow(TypeError);
  expect(readFileSync(f.path, "utf8")).toBe("synthetic-old-private-token");
  expect(native.mock.calls.some((call) => call[1] === "DELETE")).toBe(false);
});
it("refuses ambiguous owned PAT metadata before any mutation", async () => {
  const f = fixture();
  f.state.tokens.push({ ...f.state.tokens[0], id: 3 });
  await expect(ensureFixtureAdminToken(f.session)).rejects.toThrow(TypeError);
  expect(native.mock.calls.some((call) => call[1] !== "GET")).toBe(false);
});

it.each([undefined, null, "invalid", 0, NaN])(
  "refuses an unknown native token expiry before mutation: %s",
  async (expiry) => {
    const f = fixture();
    f.state.tokens[0].expiringAt = expiry;
    await expect(ensureFixtureAdminToken(f.session)).rejects.toThrow(TypeError);
    expect(native.mock.calls.some((call) => call[1] !== "GET")).toBe(false);
  },
);
it("withholds a replacement that does not outlast the requested window", async () => {
  const f = fixture();
  f.state.replacementSeconds = 60;
  await expect(ensureFixtureAdminToken(f.session)).rejects.toThrow(TypeError);
  expect(readFileSync(f.path, "utf8")).toBe("synthetic-old-private-token");
  expect(native.mock.calls.some((call) => call[1] === "DELETE")).toBe(false);
});
it("retains the verified replacement and blocks replay after uncertain predecessor retirement", async () => {
  const f = fixture();
  f.state.failRetirement = true;
  await expect(ensureFixtureAdminToken(f.session)).rejects.toThrow(TypeError);
  expect(readFileSync(f.path, "utf8")).toBe("synthetic-new-private-token");
  await expect(ensureFixtureAdminToken(f.session)).rejects.toThrow(TypeError);
  expect(native.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(1);
  expect(native.mock.calls.filter((call) => call[1] === "DELETE")).toHaveLength(1);
});

it("creates and independently verifies the initial fixture PAT once", async () => {
  const f = fixture();
  unlinkSync(f.path);
  f.state.tokens = [];
  await ensureFixtureAdminToken(f.session);
  await ensureFixtureAdminToken(f.session);
  expect(readFileSync(f.path, "utf8")).toBe("synthetic-new-private-token");
  expect(native.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(1);
  expect(native.mock.calls.some((call) => call[1] === "DELETE")).toBe(false);
});
it("keeps the original one-use guard after an uncertain initial creation", async () => {
  const f = fixture();
  unlinkSync(f.path);
  f.state.tokens = [];
  writeFileSync(join(f.session.directory, "secrets", "admin-pat-creation-started"), "1", {
    mode: 0o600,
  });
  await expect(ensureFixtureAdminToken(f.session)).rejects.toThrow();
  expect(native.mock.calls.some((call) => call[1] !== "GET")).toBe(false);
});
it("refuses a credential changed by another preflight before dispatching renewal", async () => {
  const f = fixture();
  const request = native.getMockImplementation();
  native.mockImplementation(async (...args) => {
    const result = await request(...args);
    if (args[2] === "/rest/api/2/myself")
      writeFileSync(f.path, "synthetic-concurrent-replacement", { mode: 0o600 });
    return result;
  });
  await expect(ensureFixtureAdminToken(f.session)).rejects.toThrow(TypeError);
  expect(native.mock.calls.some((call) => call[1] !== "GET")).toBe(false);
});
